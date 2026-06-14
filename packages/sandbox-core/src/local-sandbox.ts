// LocalSandbox: a real sandbox that executes on the machine running the
// runtime. Files are read and written under a fixed workspace root (paths are
// confined to it), and commands run in a child process with a timeout and a
// bounded output. This is the concrete cloud-general provider for local and
// CLI use; MemorySandbox is its in-memory test twin.

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxKind } from "../../capability-contract/src/index.js";
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
}

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_SHELL: [string, ...string[]] = ["bash", "-lc"];

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

  constructor(options: LocalSandboxOptions) {
    this.root = path.resolve(options.workspaceRoot);
    this.execTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.shell = options.shell ?? DEFAULT_SHELL;
  }

  async ensureReady(_binding: SandboxBinding): Promise<SandboxHandle> {
    await mkdir(this.root, { recursive: true });
    return { sandboxId: this.root, kind: this.kind, primitives: ["fs", "proc"] };
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
}
