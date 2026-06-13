// Wiring: adapt the gateway NodeRegistry to the sandbox NodeInvoker port.
// This is the single place that depends on both. The package-level adapter
// stays gateway-agnostic behind NodeRegistryPort; this factory is where the
// real NodeRegistry is proven to satisfy that port at compile time, so a
// client-node sandbox can run on the live reverse-RPC transport.
import { GatewayNodeInvoker, type NodeInvoker } from "../../packages/sandbox-core/src/index.js";
import type { NodeRegistry } from "../gateway/node-registry.js";

/** Builds a NodeInvoker backed by the live gateway node registry. */
export function createGatewayNodeInvoker(registry: NodeRegistry): NodeInvoker {
  return new GatewayNodeInvoker(registry);
}
