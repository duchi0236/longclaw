// Sandbox provider contract: the execution side of the capability boundary.
// A provider owns one sandbox family (cloud container, repo workspace, or a
// paired client device) and executes capability invocations inside it. It has
// no knowledge of brains, modes, or the loop — only of capability calls.

import type { SandboxKind, SandboxPrimitive } from "../../capability-contract/src/index.js";

/** How a session is bound to a concrete sandbox. Stored on the session. */
export interface SandboxBinding {
  kind: SandboxKind;
  /** Paired device id for client-node sandboxes. */
  deviceId?: string;
  /** Repository reference for cloud-repo sandboxes, e.g. "org/repo#branch". */
  repoRef?: string;
  /** Persistent workspace id for cloud-general sandboxes. */
  workspaceId?: string;
}

/** Live handle to a ready sandbox instance. */
export interface SandboxHandle {
  sandboxId: string;
  kind: SandboxKind;
  /** Primitives this concrete instance offers; drives snapshot resolution. */
  primitives: SandboxPrimitive[];
}

/** Health report for a sandbox instance. */
export interface SandboxStatus {
  healthy: boolean;
  detail?: string;
}

/** One capability invocation routed to a sandbox. */
export interface CapabilityInvocation {
  /** Correlation id assigned by the runtime, unique per call. */
  callId: string;
  capability: string;
  args: unknown;
  /**
   * Brain-chosen retry key. Providers MUST replay the cached result when they
   * see a key again instead of re-executing the effect.
   */
  idempotencyKey: string;
}

/** Result of a capability invocation. */
export interface CapabilityResult {
  isError: boolean;
  /** Textual output handed back to the brain. */
  output: string;
  /** Structured details for telemetry and UI; never shown to the brain. */
  details?: unknown;
  /** True when this result was replayed from the idempotency cache. */
  replayed?: boolean;
}

/** Error thrown when a sandbox is gone or unreachable mid-session. */
export class SandboxUnavailableError extends Error {
  constructor(
    readonly sandboxId: string,
    detail: string,
  ) {
    super(`sandbox ${sandboxId} unavailable: ${detail}`);
    this.name = "SandboxUnavailableError";
  }
}

/**
 * The execution backend for one sandbox kind. Implementations must be safe to
 * call concurrently and must honor idempotency-key replay.
 */
export interface SandboxProvider {
  kind: SandboxKind;
  /** Creates or attaches the sandbox a binding points to. Idempotent. */
  ensureReady(binding: SandboxBinding): Promise<SandboxHandle>;
  /** Releases the sandbox instance; safe to call twice. */
  release(handle: SandboxHandle): Promise<void>;
  /** Liveness probe; used to suspend sessions whose sandbox dropped. */
  heartbeat(handle: SandboxHandle): Promise<SandboxStatus>;
  /** Executes one capability invocation inside the sandbox. */
  invoke(handle: SandboxHandle, invocation: CapabilityInvocation): Promise<CapabilityResult>;
}
