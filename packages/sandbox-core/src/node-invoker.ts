// NodeInvoker: the narrow transport port the client-node sandbox depends on.
// It abstracts "send command Y to paired device X, await its result" — exactly
// the reverse-RPC the gateway already implements (node.invoke.request over the
// device websocket). Keeping this an interface lets the sandbox package stay
// free of gateway machinery; the gateway wiring injects a concrete invoker,
// tests inject a fake node.

import type { SandboxPrimitive } from "../../capability-contract/src/index.js";

/** One command dispatched to a paired node. */
export interface NodeInvokeRequest {
  /** Paired device identifier (the gateway's nodeId). */
  deviceId: string;
  /** Node command family, e.g. "system.run", "fs.read". */
  command: string;
  /** Command-specific params; the transport JSON-encodes these. */
  params: unknown;
  /** Per-call timeout; the node aborts and returns TIMEOUT past it. */
  timeoutMs?: number;
  /** Dedupe key; re-sending the same key must return the same result. */
  idempotencyKey: string;
}

/** Connection-level failure codes; these suspend the session, not the call. */
export type NodeUnavailableCode = "TIMEOUT" | "UNAVAILABLE" | "DISCONNECTED";

/** Outcome of a node invocation. `ok:false` is a transport failure, not a
 * command error — a command that ran and failed still returns `ok:true` with
 * its own error fields in `result`. */
export type NodeInvokeOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: NodeUnavailableCode; message: string };

/** Liveness and capability snapshot for a paired node. */
export interface NodeStatus {
  connected: boolean;
  /** Primitives the node offers, derived from its declared command families. */
  primitives: SandboxPrimitive[];
}

/** Transport to a paired client device. Implemented over the gateway's node
 * registry in production; faked in tests. */
export interface NodeInvoker {
  /** Current connection state and offered primitives for a device. */
  status(deviceId: string): Promise<NodeStatus>;
  /** Dispatches one command and awaits the node's response. */
  invoke(request: NodeInvokeRequest): Promise<NodeInvokeOutcome>;
}
