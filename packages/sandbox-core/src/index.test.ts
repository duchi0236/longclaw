// Sandbox core tests cover routing, leases, idempotency replay, and the
// in-memory provider's core capabilities.
import { describe, expect, it } from "vitest";
import { MemorySandbox, SandboxRouter, SandboxUnavailableError } from "./index.js";

function invocation(
  capability: string,
  args: unknown,
  idempotencyKey: string,
): Parameters<MemorySandbox["invoke"]>[1] {
  return { callId: `call-${idempotencyKey}`, capability, args, idempotencyKey };
}

describe("MemorySandbox", () => {
  it("implements the core fs and exec capabilities", async () => {
    const sandbox = new MemorySandbox({ execScript: (cmd) => ({ output: `ok:${cmd}` }) });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });

    const write = await sandbox.invoke(
      handle,
      invocation("fs.write", { path: "src/a.ts", content: "let a = 1;" }, "k1"),
    );
    expect(write.isError).toBe(false);

    const read = await sandbox.invoke(handle, invocation("fs.read", { path: "src/a.ts" }, "k2"));
    expect(read.output).toBe("let a = 1;");

    const list = await sandbox.invoke(handle, invocation("fs.list", { prefix: "src/" }, "k3"));
    expect(list.output).toBe("src/a.ts");

    const exec = await sandbox.invoke(handle, invocation("exec.run", { command: "test" }, "k4"));
    expect(exec.output).toBe("ok:test");
  });

  it("replays results for repeated idempotency keys without re-executing", async () => {
    let runs = 0;
    const sandbox = new MemorySandbox({
      execScript: (cmd) => {
        runs += 1;
        return { output: `run ${runs}: ${cmd}` };
      },
    });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });

    const first = await sandbox.invoke(handle, invocation("exec.run", { command: "build" }, "k1"));
    const second = await sandbox.invoke(handle, invocation("exec.run", { command: "build" }, "k1"));

    expect(runs).toBe(1);
    expect(second.output).toBe(first.output);
    expect(second.replayed).toBe(true);
  });

  it("fails invocations and heartbeats when marked offline", async () => {
    const sandbox = new MemorySandbox();
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });
    sandbox.setHealthy(false);

    await expect(sandbox.heartbeat(handle)).resolves.toEqual({
      healthy: false,
      detail: "sandbox marked offline",
    });
    expect(() => sandbox.invoke(handle, invocation("fs.list", {}, "k1"))).toThrow(
      SandboxUnavailableError,
    );
  });

  it("returns an error result for unknown capabilities", async () => {
    const sandbox = new MemorySandbox();
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });
    const result = await sandbox.invoke(handle, invocation("net.fetch", {}, "k1"));
    expect(result.isError).toBe(true);
  });
});

describe("SandboxRouter", () => {
  it("routes bindings to the registered provider and caches the session lease", async () => {
    const router = new SandboxRouter();
    const cloud = new MemorySandbox({ kind: "cloud-general" });
    router.register(cloud);

    const first = await router.acquire("session-1", { kind: "cloud-general" });
    const second = await router.acquire("session-1", { kind: "cloud-general" });
    expect(second.handle.sandboxId).toBe(first.handle.sandboxId);
  });

  it("re-leases when the binding moves to another sandbox kind", async () => {
    const router = new SandboxRouter();
    router.register(new MemorySandbox({ kind: "cloud-general" }));
    router.register(new MemorySandbox({ kind: "client-node" }));

    const cloudLease = await router.acquire("session-1", { kind: "cloud-general" });
    const clientLease = await router.acquire("session-1", {
      kind: "client-node",
      deviceId: "device-9",
    });
    expect(clientLease.handle.kind).toBe("client-node");
    expect(clientLease.handle.sandboxId).not.toBe(cloudLease.handle.sandboxId);
  });

  it("rejects unknown kinds and duplicate registrations", () => {
    const router = new SandboxRouter();
    const provider = new MemorySandbox({ kind: "cloud-repo" });
    router.register(provider);
    expect(() => router.register(new MemorySandbox({ kind: "cloud-repo" }))).toThrow(
      /already registered/,
    );
    expect(() => router.providerFor("client-node")).toThrow(/no sandbox provider/);
  });
});
