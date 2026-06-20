// In-memory sandbox provider: a complete, deterministic implementation of the
// core capability families used by runtime tests, shadow evaluation, and
// local development. It honors the same contract real providers must: ready
// handles, heartbeats, and idempotency-key replay.

import type { SandboxKind, SandboxPrimitive } from "../../capability-contract/src/index.js";
import {
  formatMemoryEntries,
  InMemoryMemoryStore,
  type MemoryStore,
} from "./memory-store.js";
import {
  SandboxUnavailableError,
  type CapabilityInvocation,
  type CapabilityResult,
  type SandboxBinding,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxStatus,
} from "./provider.js";

/** Scripted handler for `exec.run` commands in tests. */
export type ExecScript = (command: string) => { output: string; isError?: boolean };

/** Scripted handler for `web.fetch` requests in tests. */
export type WebScript = (
  url: string,
  init?: { headers?: Record<string, string> },
) => { output: string; isError?: boolean };

/** Scripted handler for `web.search` requests in tests. */
export type SearchScript = (
  query: string,
  options: { limit: number },
) => { output: string; isError?: boolean };

const DEFAULT_EXEC_SCRIPT: ExecScript = (command) => ({ output: `ran: ${command}` });
const DEFAULT_WEB_SCRIPT: WebScript = (url) => ({ output: `fetched: ${url}` });
const DEFAULT_SEARCH_SCRIPT: SearchScript = (query) => ({ output: `searched: ${query}` });

interface MemorySandboxOptions {
  kind?: SandboxKind;
  primitives?: SandboxPrimitive[];
  execScript?: ExecScript;
  webScript?: WebScript;
  searchScript?: SearchScript;
  memoryStore?: MemoryStore;
}

/** One recorded invocation, for assertions and telemetry tests. */
export interface RecordedInvocation {
  capability: string;
  args: unknown;
  idempotencyKey: string;
  replayed: boolean;
}

/**
 * Deterministic sandbox for tests and local development. Files live in a Map;
 * exec output comes from a scripted handler.
 */
export class MemorySandbox implements SandboxProvider {
  readonly kind: SandboxKind;
  readonly files = new Map<string, string>();
  readonly invocations: RecordedInvocation[] = [];

  private readonly primitives: SandboxPrimitive[];
  private readonly execScript: ExecScript;
  private readonly webScript: WebScript;
  private readonly searchScript: SearchScript;
  private readonly memoryStore: MemoryStore;
  private readonly idempotencyCache = new Map<string, CapabilityResult>();
  private healthy = true;
  private nextSandboxId = 1;

  constructor(options: MemorySandboxOptions = {}) {
    this.kind = options.kind ?? "cloud-general";
    this.primitives = options.primitives ?? ["fs", "net", "proc", "mem"];
    this.execScript = options.execScript ?? DEFAULT_EXEC_SCRIPT;
    this.webScript = options.webScript ?? DEFAULT_WEB_SCRIPT;
    this.searchScript = options.searchScript ?? DEFAULT_SEARCH_SCRIPT;
    this.memoryStore = options.memoryStore ?? new InMemoryMemoryStore();
  }

  /** Simulates the sandbox dropping (device offline, container evicted). */
  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  ensureReady(_binding: SandboxBinding): Promise<SandboxHandle> {
    return Promise.resolve({
      sandboxId: `${this.kind}-${this.nextSandboxId++}`,
      kind: this.kind,
      primitives: [...this.primitives],
    });
  }

  release(_handle: SandboxHandle): Promise<void> {
    return Promise.resolve();
  }

  heartbeat(_handle: SandboxHandle): Promise<SandboxStatus> {
    return Promise.resolve(
      this.healthy ? { healthy: true } : { healthy: false, detail: "sandbox marked offline" },
    );
  }

  invoke(handle: SandboxHandle, invocation: CapabilityInvocation): Promise<CapabilityResult> {
    // The unhealthy check throws synchronously (callers and tests rely on it);
    // capability execution itself is async to support store-backed families.
    if (!this.healthy) {
      throw new SandboxUnavailableError(handle.sandboxId, "sandbox marked offline");
    }
    const cached = this.idempotencyCache.get(invocation.idempotencyKey);
    if (cached) {
      const replayed = { ...cached, replayed: true };
      this.record(invocation, true);
      return Promise.resolve(replayed);
    }
    return this.execute(invocation).then((result) => {
      this.idempotencyCache.set(invocation.idempotencyKey, result);
      this.record(invocation, false);
      return result;
    });
  }

  private record(invocation: CapabilityInvocation, replayed: boolean): void {
    this.invocations.push({
      capability: invocation.capability,
      args: invocation.args,
      idempotencyKey: invocation.idempotencyKey,
      replayed,
    });
  }

  private async execute(invocation: CapabilityInvocation): Promise<CapabilityResult> {
    const args = (invocation.args ?? {}) as Record<string, unknown>;
    switch (invocation.capability) {
      case "fs.read": {
        const path = String(args.path ?? "");
        const content = this.files.get(path);
        if (content === undefined) {
          return { isError: true, output: `file not found: ${path}` };
        }
        return { isError: false, output: content };
      }
      case "fs.write": {
        const path = String(args.path ?? "");
        if (!path) {
          return { isError: true, output: "fs.write requires a path" };
        }
        this.files.set(path, String(args.content ?? ""));
        return { isError: false, output: `wrote ${path}` };
      }
      case "fs.list": {
        const prefix = String(args.prefix ?? "");
        const names = [...this.files.keys()].filter((name) => name.startsWith(prefix)).toSorted();
        return { isError: false, output: names.join("\n") };
      }
      case "exec.run": {
        const command = String(args.command ?? "");
        if (!command) {
          return { isError: true, output: "exec.run requires a command" };
        }
        const { output, isError } = this.execScript(command);
        return { isError: isError ?? false, output };
      }
      case "web.fetch": {
        const url = String(args.url ?? "");
        if (!url) {
          return { isError: true, output: "web.fetch requires a url" };
        }
        const headers = args.headers;
        const init =
          typeof headers === "object" && headers !== null
            ? { headers: headers as Record<string, string> }
            : undefined;
        const { output, isError } = this.webScript(url, init);
        return { isError: isError ?? false, output };
      }
      case "web.search": {
        const query = String(args.query ?? "").trim();
        if (!query) {
          return { isError: true, output: "web.search requires a query" };
        }
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
        const { output, isError } = this.searchScript(query, { limit });
        return { isError: isError ?? false, output };
      }
      case "memory.write": {
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
      case "memory.read": {
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
      case "memory.search": {
        const query = String(args.query ?? "").trim();
        if (!query) {
          return { isError: true, output: "memory.search requires a query" };
        }
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
        const entries = await this.memoryStore.search(query, { limit });
        return {
          isError: false,
          output: formatMemoryEntries(entries),
          details: { query, count: entries.length, results: entries },
        };
      }
      default:
        return { isError: true, output: `capability not implemented: ${invocation.capability}` };
    }
  }
}
