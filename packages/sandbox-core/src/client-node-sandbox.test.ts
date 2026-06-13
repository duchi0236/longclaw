// ClientNodeSandbox tests: a fake node simulates a paired device implementing
// the node command families (system.run + fs.*). The tests pin the routing
// contract — capability translation, command-vs-transport error split,
// idempotency replay, and connection-driven readiness/heartbeat.
import { describe, expect, it } from "vitest";
import { ClientNodeSandbox } from "./client-node-sandbox.js";
import type {
  NodeInvokeOutcome,
  NodeInvokeRequest,
  NodeInvoker,
  NodeStatus,
} from "./node-invoker.js";
import { SandboxUnavailableError, type CapabilityInvocation } from "./provider.js";

/** In-memory stand-in for a paired client device. Implements the same node
 * command families our real CLI node will. */
class FakeNode implements NodeInvoker {
  readonly files = new Map<string, string>();
  readonly dispatched: NodeInvokeRequest[] = [];
  connected = true;
  primitives: NodeStatus["primitives"] = ["fs", "proc"];
  /** Forces the next invoke to fail at the transport level. */
  transportFailure: NodeInvokeOutcome | null = null;

  status(_deviceId: string): Promise<NodeStatus> {
    return Promise.resolve({ connected: this.connected, primitives: [...this.primitives] });
  }

  invoke(request: NodeInvokeRequest): Promise<NodeInvokeOutcome> {
    this.dispatched.push(request);
    if (this.transportFailure) {
      const failure = this.transportFailure;
      this.transportFailure = null;
      return Promise.resolve(failure);
    }
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.command) {
      case "system.run": {
        const raw = String(params.rawCommand ?? "");
        if (raw.startsWith("fail")) {
          return Promise.resolve({
            ok: true,
            result: { success: false, exitCode: 1, stdout: "", stderr: "boom" },
          });
        }
        return Promise.resolve({
          ok: true,
          result: { success: true, exitCode: 0, stdout: `device ran: ${raw}`, stderr: "" },
        });
      }
      case "fs.write":
        this.files.set(String(params.path), String(params.content));
        return Promise.resolve({ ok: true, result: { ok: true } });
      case "fs.read": {
        const content = this.files.get(String(params.path));
        return Promise.resolve({
          ok: true,
          result: content === undefined ? { found: false } : { found: true, content },
        });
      }
      case "fs.list": {
        const prefix = String(params.prefix ?? "");
        const names = [...this.files.keys()].filter((n) => n.startsWith(prefix)).toSorted();
        return Promise.resolve({ ok: true, result: { names } });
      }
      default:
        return Promise.resolve({ ok: false, code: "UNAVAILABLE", message: "unknown command" });
    }
  }
}

function call(capability: string, args: unknown, key: string): CapabilityInvocation {
  return { callId: `c-${key}`, capability, args, idempotencyKey: key };
}

async function ready(node: FakeNode) {
  const sandbox = new ClientNodeSandbox(node);
  const handle = await sandbox.ensureReady({ kind: "client-node", deviceId: "device-7" });
  return { sandbox, handle };
}

describe("ClientNodeSandbox", () => {
  it("translates fs and exec capabilities to node commands round-trip", async () => {
    const node = new FakeNode();
    const { sandbox, handle } = await ready(node);

    const write = await sandbox.invoke(
      handle,
      call("fs.write", { path: "a.txt", content: "hi" }, "k1"),
    );
    expect(write.isError).toBe(false);
    expect(node.files.get("a.txt")).toBe("hi");

    const read = await sandbox.invoke(handle, call("fs.read", { path: "a.txt" }, "k2"));
    expect(read.output).toBe("hi");

    const list = await sandbox.invoke(handle, call("fs.list", { prefix: "a" }, "k3"));
    expect(list.output).toBe("a.txt");

    const exec = await sandbox.invoke(handle, call("exec.run", { command: "echo hi" }, "k4"));
    expect(exec.output).toBe("device ran: echo hi");

    // exec.run must route to the gateway's existing system.run command.
    expect(node.dispatched.map((d) => d.command)).toEqual([
      "fs.write",
      "fs.read",
      "fs.list",
      "system.run",
    ]);
  });

  it("maps a command that ran-and-failed to an error result, not a transport failure", async () => {
    const node = new FakeNode();
    const { sandbox, handle } = await ready(node);

    const exec = await sandbox.invoke(handle, call("exec.run", { command: "fail now" }, "k1"));
    expect(exec.isError).toBe(true);
    expect(exec.output).toContain("boom");

    const missing = await sandbox.invoke(handle, call("fs.read", { path: "nope.txt" }, "k2"));
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("not found");
  });

  it("surfaces transport failures as SandboxUnavailableError to suspend the session", async () => {
    const node = new FakeNode();
    const { sandbox, handle } = await ready(node);
    node.transportFailure = { ok: false, code: "TIMEOUT", message: "device invoke timed out" };

    await expect(sandbox.invoke(handle, call("fs.list", {}, "k1"))).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
  });

  it("replays cached results for repeated idempotency keys without re-dispatching", async () => {
    const node = new FakeNode();
    const { sandbox, handle } = await ready(node);

    const first = await sandbox.invoke(handle, call("exec.run", { command: "echo once" }, "k1"));
    const second = await sandbox.invoke(handle, call("exec.run", { command: "echo once" }, "k1"));

    expect(second.output).toBe(first.output);
    expect(second.replayed).toBe(true);
    expect(node.dispatched.filter((d) => d.command === "system.run")).toHaveLength(1);
  });

  it("refuses to ready a disconnected device and reports it in heartbeat", async () => {
    const node = new FakeNode();
    node.connected = false;
    const sandbox = new ClientNodeSandbox(node);

    await expect(
      sandbox.ensureReady({ kind: "client-node", deviceId: "device-7" }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);

    node.connected = true;
    const handle = await sandbox.ensureReady({ kind: "client-node", deviceId: "device-7" });
    expect(handle.primitives).toEqual(["fs", "proc"]);

    node.connected = false;
    expect(await sandbox.heartbeat(handle)).toEqual({
      healthy: false,
      detail: "device disconnected",
    });
  });

  it("requires a deviceId in the binding", async () => {
    const sandbox = new ClientNodeSandbox(new FakeNode());
    await expect(sandbox.ensureReady({ kind: "client-node" })).rejects.toThrow(/deviceId/);
  });
});
