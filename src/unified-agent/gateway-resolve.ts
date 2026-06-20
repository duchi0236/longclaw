// Phase 4 — gateway execution context → sandbox binding. The gateway knows
// where a turn should run (a paired device, a repo workspace, or a general
// cloud workspace); this resolves that into the SandboxBinding the unified
// runtime routes on. Precedence: a paired device wins, then a repo, else a
// general workspace.

import type { SandboxBinding } from "../../packages/sandbox-core/src/index.js";

/** Where the gateway wants a turn to execute. */
export interface GatewayExecutionContext {
  /** Paired client device id → client-node sandbox. */
  deviceId?: string;
  /** Repository ref "org/repo#branch" → cloud-repo sandbox. */
  repoRef?: string;
  /** Persistent workspace id → cloud-general sandbox. */
  workspaceId?: string;
}

/** Resolves a sandbox binding from the gateway execution context. */
export function resolveBinding(ctx: GatewayExecutionContext = {}): SandboxBinding {
  if (ctx.deviceId) {
    return { kind: "client-node", deviceId: ctx.deviceId };
  }
  if (ctx.repoRef) {
    return { kind: "cloud-repo", repoRef: ctx.repoRef };
  }
  return {
    kind: "cloud-general",
    ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
  };
}
