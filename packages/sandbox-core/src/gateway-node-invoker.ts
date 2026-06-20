// GatewayNodeInvoker: implements the NodeInvoker transport on top of the
// gateway's node registry reverse-RPC. It depends on a narrow NodeRegistryPort
// (a structural subset of src/gateway NodeRegistry) rather than importing the
// gateway, so this package stays free of gateway machinery. The real
// NodeRegistry satisfies NodeRegistryPort structurally; the production wiring
// that hands it in lives in src/sandbox.

import type { SandboxPrimitive } from "../../capability-contract/src/index.js";
import type {
  NodeInvokeOutcome,
  NodeInvokeRequest,
  NodeInvoker,
  NodeStatus,
  NodeUnavailableCode,
} from "./node-invoker.js";

/** Subset of a node session this adapter reads. Matches NodeRegistry's
 * NodeSession.commands (the runtime-approved command families). */
export interface NodeRegistrySession {
  commands: string[];
}

/** Result shape returned by NodeRegistry.invoke. */
export interface NodeRegistryInvokeResult {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
}

/** Narrow port over the gateway node registry. The real NodeRegistry
 * satisfies this structurally — no gateway import needed here. */
export interface NodeRegistryPort {
  get(nodeId: string): NodeRegistrySession | undefined;
  invoke(params: {
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<NodeRegistryInvokeResult>;
}

// Node command families that imply each sandbox primitive. Mirrors the
// commands client-node-protocol emits; a node advertising them can serve the
// matching capability family.
const FS_COMMANDS = new Set(["fs.read", "fs.write", "fs.list"]);
const PROC_COMMANDS = new Set(["system.run"]);
const NET_COMMANDS = new Set(["web.fetch", "web.search"]);
const MEM_COMMANDS = new Set(["memory.write", "memory.read", "memory.search"]);

function derivePrimitives(commands: string[]): SandboxPrimitive[] {
  const primitives: SandboxPrimitive[] = [];
  if (commands.some((c) => FS_COMMANDS.has(c))) {
    primitives.push("fs");
  }
  if (commands.some((c) => NET_COMMANDS.has(c))) {
    primitives.push("net");
  }
  if (commands.some((c) => PROC_COMMANDS.has(c))) {
    primitives.push("proc");
  }
  if (commands.some((c) => MEM_COMMANDS.has(c))) {
    primitives.push("mem");
  }
  return primitives;
}

// Maps NodeRegistry error codes to the transport-failure codes the sandbox
// understands. NOT_CONNECTED becomes DISCONNECTED; anything unrecognized is
// treated as UNAVAILABLE so the runtime suspends rather than mislabels.
function mapErrorCode(code: string | undefined): NodeUnavailableCode {
  switch (code) {
    case "TIMEOUT":
      return "TIMEOUT";
    case "NOT_CONNECTED":
      return "DISCONNECTED";
    default:
      return "UNAVAILABLE";
  }
}

function parsePayload(result: NodeRegistryInvokeResult): unknown {
  if (typeof result.payloadJSON === "string") {
    try {
      return JSON.parse(result.payloadJSON);
    } catch {
      // A node that returns malformed JSON is a protocol violation; pass the
      // raw string through so the capability layer reports a clear error.
      return result.payloadJSON;
    }
  }
  return result.payload;
}

/** NodeInvoker backed by the gateway node registry. */
export class GatewayNodeInvoker implements NodeInvoker {
  constructor(private readonly registry: NodeRegistryPort) {}

  status(deviceId: string): Promise<NodeStatus> {
    const session = this.registry.get(deviceId);
    if (!session) {
      return Promise.resolve({ connected: false, primitives: [] });
    }
    return Promise.resolve({ connected: true, primitives: derivePrimitives(session.commands) });
  }

  async invoke(request: NodeInvokeRequest): Promise<NodeInvokeOutcome> {
    const result = await this.registry.invoke({
      nodeId: request.deviceId,
      command: request.command,
      params: request.params,
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      idempotencyKey: request.idempotencyKey,
    });
    if (result.ok) {
      return { ok: true, result: parsePayload(result) };
    }
    return {
      ok: false,
      code: mapErrorCode(result.error?.code ?? undefined),
      message: result.error?.message ?? "node invoke failed",
    };
  }
}
