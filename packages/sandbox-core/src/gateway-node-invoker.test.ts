// GatewayNodeInvoker tests: primitive derivation from declared commands,
// result/error mapping from the registry's NodeInvokeResult shape, and an
// end-to-end run through ClientNodeSandbox proving a capability call reaches
// the registry and a JSON payload flows back. The fake registry mirrors the
// real NodeRegistry.invoke / .get contract (src/gateway/node-registry.ts).
import { describe, expect, it } from "vitest";
import { ClientNodeSandbox } from "./client-node-sandbox.js";
import {
  GatewayNodeInvoker,
  type NodeRegistryInvokeResult,
  type NodeRegistryPort,
  type NodeRegistrySession,
} from "./gateway-node-invoker.js";
import { SandboxUnavailableError, type CapabilityInvocation } from "./provider.js";

class FakeRegistry implements NodeRegistryPort {
  readonly sessions = new Map<string, NodeRegistrySession>();
  readonly calls: { nodeId: string; command: string; params?: unknown; idempotencyKey?: string }[] =
    [];
  nextResult: NodeRegistryInvokeResult = { ok: true, payload: {} };

  get(nodeId: string): NodeRegistrySession | undefined {
    return this.sessions.get(nodeId);
  }

  invoke(params: {
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<NodeRegistryInvokeResult> {
    this.calls.push(params);
    return Promise.resolve(this.nextResult);
  }
}

describe("GatewayNodeInvoker.status", () => {
  it("reports disconnected when the registry has no session", async () => {
    const registry = new FakeRegistry();
    const status = await new GatewayNodeInvoker(registry).status("device-1");
    expect(status).toEqual({ connected: false, primitives: [] });
  });

  it("derives primitives from declared command families", async () => {
    const registry = new FakeRegistry();
    registry.sessions.set("dev-fs", { commands: ["fs.read", "fs.write"] });
    registry.sessions.set("dev-proc", { commands: ["system.run"] });
    registry.sessions.set("dev-both", { commands: ["fs.list", "system.run", "camera.snap"] });

    expect((await new GatewayNodeInvoker(registry).status("dev-fs")).primitives).toEqual(["fs"]);
    expect((await new GatewayNodeInvoker(registry).status("dev-proc")).primitives).toEqual([
      "proc",
    ]);
    expect((await new GatewayNodeInvoker(registry).status("dev-both")).primitives).toEqual([
      "fs",
      "proc",
    ]);
  });
});

describe("GatewayNodeInvoker.invoke", () => {
  it("forwards params as an object and parses a JSON payload", async () => {
    const registry = new FakeRegistry();
    registry.nextResult = { ok: true, payloadJSON: '{"found":true,"content":"hi"}' };
    const outcome = await new GatewayNodeInvoker(registry).invoke({
      deviceId: "dev-1",
      command: "fs.read",
      params: { path: "a.txt" },
      idempotencyKey: "k1",
    });

    expect(outcome).toEqual({ ok: true, result: { found: true, content: "hi" } });
    // params passed through as an object; the registry stringifies internally.
    expect(registry.calls[0]).toMatchObject({
      nodeId: "dev-1",
      command: "fs.read",
      params: { path: "a.txt" },
      idempotencyKey: "k1",
    });
  });

  it("returns the raw payload when there is no JSON string", async () => {
    const registry = new FakeRegistry();
    registry.nextResult = { ok: true, payload: { exitCode: 0 } };
    const outcome = await new GatewayNodeInvoker(registry).invoke({
      deviceId: "d",
      command: "system.run",
      params: {},
      idempotencyKey: "k1",
    });
    expect(outcome).toEqual({ ok: true, result: { exitCode: 0 } });
  });

  it("maps registry error codes to transport-failure codes", async () => {
    const cases: [string | undefined, string][] = [
      ["TIMEOUT", "TIMEOUT"],
      ["NOT_CONNECTED", "DISCONNECTED"],
      ["UNAVAILABLE", "UNAVAILABLE"],
      [undefined, "UNAVAILABLE"],
    ];
    for (const [code, expected] of cases) {
      const registry = new FakeRegistry();
      registry.nextResult = { ok: false, error: { code, message: "boom" } };
      const outcome = await new GatewayNodeInvoker(registry).invoke({
        deviceId: "d",
        command: "fs.list",
        params: {},
        idempotencyKey: "k1",
      });
      expect(outcome).toEqual({ ok: false, code: expected, message: "boom" });
    }
  });
});

describe("ClientNodeSandbox over GatewayNodeInvoker", () => {
  function call(capability: string, args: unknown, key: string): CapabilityInvocation {
    return { callId: `c-${key}`, capability, args, idempotencyKey: key };
  }

  it("routes a capability call through the registry and parses the result", async () => {
    const registry = new FakeRegistry();
    registry.sessions.set("macbook", {
      commands: ["fs.read", "fs.write", "fs.list", "system.run"],
    });
    const sandbox = new ClientNodeSandbox(new GatewayNodeInvoker(registry));

    const handle = await sandbox.ensureReady({ kind: "client-node", deviceId: "macbook" });
    expect(handle.primitives).toEqual(["fs", "proc"]);

    registry.nextResult = { ok: true, payloadJSON: '{"found":true,"content":"file body"}' };
    const read = await sandbox.invoke(handle, call("fs.read", { path: "src/a.ts" }, "k1"));

    expect(read).toMatchObject({ isError: false, output: "file body" });
    expect(registry.calls.at(-1)).toMatchObject({ nodeId: "macbook", command: "fs.read" });
  });

  it("suspends when the registry reports the node gone", async () => {
    const registry = new FakeRegistry();
    registry.sessions.set("macbook", { commands: ["fs.list"] });
    const sandbox = new ClientNodeSandbox(new GatewayNodeInvoker(registry));
    const handle = await sandbox.ensureReady({ kind: "client-node", deviceId: "macbook" });

    registry.nextResult = { ok: false, error: { code: "NOT_CONNECTED", message: "gone" } };
    await expect(sandbox.invoke(handle, call("fs.list", {}, "k1"))).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
  });
});
