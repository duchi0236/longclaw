// In-memory sandbox provider: a complete, deterministic implementation of the
// core capability families used by runtime tests, shadow evaluation, and
// local development. It honors the same contract real providers must: ready
// handles, heartbeats, and idempotency-key replay.

import type { SandboxKind, SandboxPrimitive } from "../../capability-contract/src/index.js";
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

const DEFAULT_EXEC_SCRIPT: ExecScript = (command) => ({ output: `ran: ${command}` });

interface MemorySandboxOptions {
  kind?: SandboxKind;
  primitives?: SandboxPrimitive[];
  execScript?: ExecScript;
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
  private readonly idempotencyCache = new Map<string, CapabilityResult>();
  private healthy = true;
  private nextSandboxId = 1;

  constructor(options: MemorySandboxOptions = {}) {
    this.kind = options.kind ?? "cloud-general";
    this.primitives = options.primitives ?? ["fs", "proc"];
    this.execScript = options.execScript ?? DEFAULT_EXEC_SCRIPT;
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
    if (!this.healthy) {
      throw new SandboxUnavailableError(handle.sandboxId, "sandbox marked offline");
    }
    const cached = this.idempotencyCache.get(invocation.idempotencyKey);
    if (cached) {
      const replayed = { ...cached, replayed: true };
      this.record(invocation, true);
      return Promise.resolve(replayed);
    }
    const result = this.execute(invocation);
    this.idempotencyCache.set(invocation.idempotencyKey, result);
    this.record(invocation, false);
    return Promise.resolve(result);
  }

  private record(invocation: CapabilityInvocation, replayed: boolean): void {
    this.invocations.push({
      capability: invocation.capability,
      args: invocation.args,
      idempotencyKey: invocation.idempotencyKey,
      replayed,
    });
  }

  private execute(invocation: CapabilityInvocation): CapabilityResult {
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
      default:
        return { isError: true, output: `capability not implemented: ${invocation.capability}` };
    }
  }
}
