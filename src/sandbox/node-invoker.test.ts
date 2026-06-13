// Proves the real gateway NodeRegistry satisfies the sandbox NodeInvoker port
// at runtime, not just by hand-matched types: a freshly constructed
// NodeRegistry adapts cleanly and reports an unknown device as disconnected.
import { describe, expect, it } from "vitest";
import { NodeRegistry } from "../gateway/node-registry.js";
import { createGatewayNodeInvoker } from "./node-invoker.js";

describe("createGatewayNodeInvoker", () => {
  it("adapts a real NodeRegistry and reports unknown devices as disconnected", async () => {
    const registry = new NodeRegistry();
    const invoker = createGatewayNodeInvoker(registry);
    expect(await invoker.status("never-paired")).toEqual({ connected: false, primitives: [] });
  });
});
