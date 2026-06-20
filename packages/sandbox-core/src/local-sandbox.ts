// LocalSandbox: a real sandbox that executes on the machine running the
// runtime. Files are read and written under a fixed workspace root (paths are
// confined to it), and commands run in a child process with a timeout and a
// bounded output. This is the concrete cloud-general provider for local and
// CLI use; MemorySandbox is its in-memory test twin.

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxKind } from "../../capability-contract/src/index.js";
import { formatMemoryEntries, InMemoryMemoryStore, type MemoryStore } from "./memory-store.js";
import type {
  CapabilityInvocation,
  CapabilityResult,
  SandboxBinding,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
} from "./provider.js";

/** Options for a local sandbox instance. */
export interface LocalSandboxOptions {
  /** Root directory; all fs access and command cwd are confined here. */
  workspaceRoot: string;
  /** Per-command timeout in milliseconds. Default 30s. */
  execTimeoutMs?: number;
  /** Max captured stdout+stderr bytes before truncation. Default 1 MiB. */
  maxOutputBytes?: number;
  /** Shell argv prefix used to run a command string. Default bash -lc. */
  shell?: [string, ...string[]];
  /** Fetch implementation used by `web.fetch`. Defaults to global fetch;
   * tests inject a fake. Production wiring should pass a fetch guarded by the
   * net-policy SSRF layer. */
  fetchImpl?: FetchLike;
  /** Per-request timeout for `web.fetch` in milliseconds. Default 15s. */
  fetchTimeoutMs?: number;
  /** Max response bytes captured by `web.fetch` before truncation. Default 2 MiB. */
  maxFetchBytes?: number;
  /** Search backend used by `web.search`. When omitted, `web.search` returns a
   * clear "not configured" error — search needs a provider (Brave, DuckDuckGo,
   * Exa, …) wired in at assembly time. */
  searchImpl?: SearchLike;
  /** Default result cap for `web.search`. Default 5. */
  searchLimit?: number;
  /** Backend for the `memory.*` capabilities. Defaults to an in-process store;
   * production should inject a durable one. */
  memoryStore?: MemoryStore;
}

/** Minimal fetch shape used by `web.fetch`, so the sandbox depends on a port
 * rather than the global directly (and so tests can inject a fake). */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

/** One web search result. */
export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

/** Pluggable web search backend used by `web.search`. */
export type SearchLike = (query: string, options: { limit: number }) => Promise<SearchResult[]>;

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_FETCH_BYTES = 2 * 1024 * 1024;
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_SHELL: [string, ...string[]] = ["bash", "-lc"];

/** Renders search results into the compact text block handed to the brain. */
function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "no results";
  }
  return results
    .map((result, index) => {
      const head = `${index + 1}. ${result.title} — ${result.url}`;
      return result.snippet ? `${head}\n   ${result.snippet}` : head;
    })
    .join("\n");
}

/** Resolves a workspace-relative path, rejecting anything that escapes the
 * root. Returns null on an out-of-bounds path. */
function resolveWithinRoot(root: string, relativePath: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) {
    return resolved;
  }
  return null;
}

/** Runs a command string in a child process, capturing bounded output. */
function runCommand(
  command: string,
  options: { cwd: string; timeoutMs: number; maxOutputBytes: number; shell: [string, ...string[]] },
): Promise<{ exitCode: number | null; timedOut: boolean; output: string; truncated: boolean }> {
  return new Promise((resolve) => {
    const [bin, ...flags] = options.shell;
    const child = spawn(bin, [...flags, command], { cwd: options.cwd });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;

    const onData = (chunk: Buffer): void => {
      if (size >= options.maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = options.maxOutputBytes - size;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      size += slice.length;
      if (chunk.length > remaining) {
        truncated = true;
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, output: String(error), truncated });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        timedOut,
        output: Buffer.concat(chunks).toString("utf8"),
        truncated,
      });
    });
  });
}

/** Coerces an untrusted headers value into a string→string record. */
function toHeaderRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Reads a response body as UTF-8 text, stopping once maxBytes is reached so a
 * huge response can never blow up memory. Returns whether it was truncated. */
async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!body) {
    return { text: "", bytes: 0, truncated: false };
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      const remaining = maxBytes - size;
      if (value.byteLength > remaining) {
        chunks.push(Buffer.from(value.subarray(0, remaining)));
        size += remaining;
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes: size, truncated };
}

/** Sandbox executing against the local filesystem and shell. */
export class LocalSandbox implements SandboxProvider {
  readonly kind: SandboxKind = "cloud-general";

  // Honors the provider idempotency contract: a replayed key returns the
  // cached result without re-running the effect.
  private readonly idempotencyCache = new Map<string, CapabilityResult>();
  private readonly root: string;
  private readonly execTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly shell: [string, ...string[]];
  private readonly fetchImpl: FetchLike;
  private readonly fetchTimeoutMs: number;
  private readonly maxFetchBytes: number;
  private readonly searchImpl?: SearchLike;
  private readonly searchLimit: number;
  private readonly memoryStore: MemoryStore;

  constructor(options: LocalSandboxOptions) {
    this.root = path.resolve(options.workspaceRoot);
    this.execTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.maxFetchBytes = options.maxFetchBytes ?? DEFAULT_MAX_FETCH_BYTES;
    this.searchImpl = options.searchImpl;
    this.searchLimit = options.searchLimit ?? DEFAULT_SEARCH_LIMIT;
    this.memoryStore = options.memoryStore ?? new InMemoryMemoryStore();
    this.shell = options.shell ?? DEFAULT_SHELL;
  }

  async ensureReady(_binding: SandboxBinding): Promise<SandboxHandle> {
    await mkdir(this.root, { recursive: true });
    return { sandboxId: this.root, kind: this.kind, primitives: ["fs", "net", "proc", "mem"] };
  }

  release(_handle: SandboxHandle): Promise<void> {
    return Promise.resolve();
  }

  heartbeat(_handle: SandboxHandle): Promise<SandboxStatus> {
    return Promise.resolve({ healthy: true });
  }

  async invoke(
    _handle: SandboxHandle,
    invocation: CapabilityInvocation,
  ): Promise<CapabilityResult> {
    const cached = this.idempotencyCache.get(invocation.idempotencyKey);
    if (cached) {
      return { ...cached, replayed: true };
    }
    const result = await this.execute(invocation);
    this.idempotencyCache.set(invocation.idempotencyKey, result);
    return result;
  }

  private async execute(invocation: CapabilityInvocation): Promise<CapabilityResult> {
    const args = (invocation.args ?? {}) as Record<string, unknown>;
    switch (invocation.capability) {
      case "fs.read":
        return this.readFileCapability(String(args.path ?? ""));
      case "fs.write":
        return this.writeFileCapability(String(args.path ?? ""), String(args.content ?? ""));
      case "fs.list":
        return this.listCapability(String(args.prefix ?? ""));
      case "exec.run":
        return this.execCapability(String(args.command ?? ""), args.timeoutMs);
      case "web.fetch":
        return this.webFetchCapability(args);
      case "web.search":
        return this.webSearchCapability(args);
      case "memory.write":
        return this.memoryWriteCapability(args);
      case "memory.read":
        return this.memoryReadCapability(args);
      case "memory.search":
        return this.memorySearchCapability(args);
      default:
        return { isError: true, output: `capability not implemented: ${invocation.capability}` };
    }
  }

  private async readFileCapability(relativePath: string): Promise<CapabilityResult> {
    const resolved = resolveWithinRoot(this.root, relativePath);
    if (!resolved) {
      return { isError: true, output: `path escapes workspace: ${relativePath}` };
    }
    try {
      return { isError: false, output: await readFile(resolved, "utf8") };
    } catch {
      return { isError: true, output: `file not found: ${relativePath}` };
    }
  }

  private async writeFileCapability(
    relativePath: string,
    content: string,
  ): Promise<CapabilityResult> {
    const resolved = resolveWithinRoot(this.root, relativePath);
    if (!resolved) {
      return { isError: true, output: `path escapes workspace: ${relativePath}` };
    }
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8");
    return { isError: false, output: `wrote ${relativePath}` };
  }

  private async listCapability(prefix: string): Promise<CapabilityResult> {
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(this.root, path.join(entry.parentPath, entry.name)))
      .filter((name) => name.startsWith(prefix))
      .toSorted();
    return { isError: false, output: names.join("\n") };
  }

  private async execCapability(command: string, timeoutArg: unknown): Promise<CapabilityResult> {
    if (!command) {
      return { isError: true, output: "exec.run requires a command" };
    }
    const timeoutMs = typeof timeoutArg === "number" ? timeoutArg : this.execTimeoutMs;
    const run = await runCommand(command, {
      cwd: this.root,
      timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      shell: this.shell,
    });
    const ok = run.exitCode === 0 && !run.timedOut;
    const suffix = run.timedOut
      ? "\n[timed out]"
      : run.exitCode === 0
        ? ""
        : `\n[exit ${run.exitCode ?? "?"}]`;
    const truncation = run.truncated ? "\n[output truncated]" : "";
    return {
      isError: !ok,
      output: `${run.output}${suffix}${truncation}`,
      details: { exitCode: run.exitCode, timedOut: run.timedOut, truncated: run.truncated },
    };
  }

  private async webFetchCapability(args: Record<string, unknown>): Promise<CapabilityResult> {
    const url = String(args.url ?? "");
    if (!url) {
      return { isError: true, output: "web.fetch requires a url" };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { isError: true, output: `invalid url: ${url}` };
    }
    // Only http(s) is allowed. Production wiring should layer the net-policy
    // SSRF guard on top of this scheme check (private-range and userinfo
    // rejection); that guard is intentionally out of scope for this provider.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { isError: true, output: `unsupported url scheme: ${parsed.protocol}` };
    }
    const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : this.fetchTimeoutMs;
    const maxBytes = typeof args.maxBytes === "number" ? args.maxBytes : this.maxFetchBytes;
    const headers = toHeaderRecord(args.headers);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...(headers ? { headers } : {}),
        signal: controller.signal,
      });
      const { text, bytes, truncated } = await readBoundedText(response.body, maxBytes);
      const contentType = response.headers.get("content-type") ?? undefined;
      const details = { status: response.status, contentType, bytes, truncated };
      if (!response.ok) {
        return { isError: true, output: `[http ${response.status}]\n${text}`.trim(), details };
      }
      return {
        isError: false,
        output: truncated ? `${text}\n[output truncated]` : text,
        details,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return { isError: true, output: `web.fetch timed out after ${timeoutMs}ms` };
      }
      return { isError: true, output: `web.fetch failed: ${String(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  private async webSearchCapability(args: Record<string, unknown>): Promise<CapabilityResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { isError: true, output: "web.search requires a query" };
    }
    if (!this.searchImpl) {
      return { isError: true, output: "web.search has no search backend configured" };
    }
    const limit =
      typeof args.limit === "number" && args.limit > 0
        ? Math.floor(args.limit)
        : this.searchLimit;
    try {
      const results = await this.searchImpl(query, { limit });
      const capped = results.slice(0, limit);
      return {
        isError: false,
        output: formatSearchResults(capped),
        details: { query, count: capped.length, results: capped },
      };
    } catch (error) {
      return { isError: true, output: `web.search failed: ${String(error)}` };
    }
  }

  private async memoryWriteCapability(args: Record<string, unknown>): Promise<CapabilityResult> {
    const text = String(args.text ?? "");
    if (!text) {
      return { isError: true, output: "memory.write requires text" };
    }
    const key = typeof args.key === "string" && args.key.length > 0 ? args.key : undefined;
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((tag): tag is string => typeof tag === "string")
      : undefined;
    const entry = await this.memoryStore.write({
      ...(key ? { key } : {}),
      text,
      ...(tags ? { tags } : {}),
    });
    return { isError: false, output: `stored: ${entry.key}`, details: entry };
  }

  private async memoryReadCapability(args: Record<string, unknown>): Promise<CapabilityResult> {
    const key = String(args.key ?? "");
    if (!key) {
      return { isError: true, output: "memory.read requires a key" };
    }
    const entry = await this.memoryStore.read(key);
    if (!entry) {
      return { isError: true, output: `memory not found: ${key}` };
    }
    return { isError: false, output: entry.text, details: entry };
  }

  private async memorySearchCapability(args: Record<string, unknown>): Promise<CapabilityResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { isError: true, output: "memory.search requires a query" };
    }
    const limit =
      typeof args.limit === "number" && args.limit > 0
        ? Math.floor(args.limit)
        : this.searchLimit;
    const entries = await this.memoryStore.search(query, { limit });
    return {
      isError: false,
      output: formatMemoryEntries(entries),
      details: { query, count: entries.length, results: entries },
    };
  }
}
