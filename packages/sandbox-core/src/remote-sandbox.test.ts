// RemoteSandbox tests: the provider contract against a fake transport (ensure,
// invoke success/error/transport-failure, idempotency, heartbeat, best-effort
// release) and the default HTTP transport against a real local server.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxUnavailableError, type CapabilityInvocation } from "./provider.js";
import {
  HttpRemoteSandboxTransport,
  RemoteSandbox,
  type RemoteInvokeOutcome,
  type RemoteSandboxTransport,
} from "./remote-sandbox.js";

function call(capability: string, args: unknown, key: string): CapabilityInvocation {
  return { callId: `c-${key}`, capability, args, idempotencyKey: key };
}

/** Builds a fake transport; every method defaults to a benign success. */
function fakeTransport(overrides: Partial<RemoteSandboxTransport> = {}): RemoteSandboxTransport {
  return {
    ensure: () => Promise.resolve({ sandboxId: "sbx-1", primitives: ["fs", "proc"] }),
    invoke: () => Promise.resolve<RemoteInvokeOutcome>({ ok: true, result: { isError: false, output: "ok" } }),
    status: () => Promise.resolve({ healthy: true }),
    release: () => Promise.resolve(),
    ...overrides,
  };
}

describe("RemoteSandbox provider", () => {
  it("creates a handle from the transport's ensure", async () => {
    const sandbox = new RemoteSandbox(fakeTransport());
    const handle = await sandbox.ensureReady({ kind: "cloud-general", workspaceId: "w1" });
    expect(handle).toEqual({ sandboxId: "sbx-1", kind: "cloud-general", primitives: ["fs", "proc"] });
  });

  it("throws SandboxUnavailable when ensure fails", async () => {
    const sandbox = new RemoteSandbox(
      fakeTransport({ ensure: () => Promise.reject(new Error("no capacity")) }),
    );
    await expect(sandbox.ensureReady({ kind: "cloud-general" })).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
  });

  it("returns successful capability results", async () => {
    const sandbox = new RemoteSandbox(
      fakeTransport({
        invoke: () =>
          Promise.resolve({ ok: true, result: { isError: false, output: "done", details: { x: 1 } } }),
      }),
    );
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });
    const result = await sandbox.invoke(handle, call("exec.run", { command: "ls" }, "k1"));
    expect(result).toMatchObject({ isError: false, output: "done", details: { x: 1 } });
  });

  it("passes through capability errors without throwing", async () => {
    const sandbox = new RemoteSandbox(
      fakeTransport({
        invoke: () => Promise.resolve({ ok: true, result: { isError: true, output: "boom" } }),
      }),
    );
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });
    const result = await sandbox.invoke(handle, call("exec.run", { command: "x" }, "k1"));
    expect(result.isError).toBe(true);
    expect(result.output).toBe("boom");
  });

  it("throws SandboxUnavailable on a transport failure", async () => {
    const sandbox = new RemoteSandbox(
      fakeTransport({
        invoke: () => Promise.resolve({ ok: false, code: "DISCONNECTED", message: "gone" }),
      }),
    );
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });
    await expect(
      sandbox.invoke(handle, call("exec.run", { command: "x" }, "k1")),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("replays a repeated idempotency key without re-dispatching", async () => {
    let calls = 0;
    const sandbox = new RemoteSandbox(
      fakeTransport({
        invoke: () => {
          calls += 1;
          return Promise.resolve({ ok: true, result: { isError: false, output: `run ${calls}` } });
        },
      }),
    );
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });
    const first = await sandbox.invoke(handle, call("exec.run", { command: "x" }, "dup"));
    const second = await sandbox.invoke(handle, call("exec.run", { command: "x" }, "dup"));
    expect(calls).toBe(1);
    expect(second.output).toBe(first.output);
    expect(second.replayed).toBe(true);
  });

  it("reports heartbeat health and never throws on release", async () => {
    const healthy = new RemoteSandbox(fakeTransport());
    const handle = await healthy.ensureReady({ kind: "cloud-general" });
    await expect(healthy.heartbeat(handle)).resolves.toEqual({ healthy: true });

    const unhealthy = new RemoteSandbox(
      fakeTransport({ status: () => Promise.resolve({ healthy: false, detail: "evicted" }) }),
    );
    await expect(unhealthy.heartbeat(handle)).resolves.toEqual({
      healthy: false,
      detail: "evicted",
    });

    const flaky = new RemoteSandbox(
      fakeTransport({ release: () => Promise.reject(new Error("network")) }),
    );
    await expect(flaky.release(handle)).resolves.toBeUndefined();
  });
});

describe("HttpRemoteSandboxTransport", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  async function startServer(
    handler: (path: string, body: unknown) => { status?: number; json: unknown } | "hang",
  ): Promise<string> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        const outcome = handler(req.url ?? "", body);
        if (outcome === "hang") {
          return; // never respond — exercises the client timeout
        }
        res.writeHead(outcome.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(outcome.json));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  it("round-trips ensure / invoke / status / release", async () => {
    const seen: string[] = [];
    const baseUrl = await startServer((path, body) => {
      seen.push(path);
      if (path === "/ensure") {
        return { json: { sandboxId: "remote-9", primitives: ["fs", "net", "proc"] } };
      }
      if (path === "/invoke") {
        const b = body as { capability: string };
        return { json: { ok: true, result: { isError: false, output: `ran ${b.capability}` } } };
      }
      if (path === "/status") {
        return { json: { healthy: true } };
      }
      return { json: {} };
    });

    const transport = new HttpRemoteSandboxTransport({ baseUrl });
    const sandbox = new RemoteSandbox(transport);
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });
    expect(handle.sandboxId).toBe("remote-9");
    expect(handle.primitives).toContain("net");

    const result = await sandbox.invoke(handle, call("exec.run", { command: "ls" }, "k1"));
    expect(result.output).toBe("ran exec.run");

    await expect(sandbox.heartbeat(handle)).resolves.toEqual({ healthy: true });
    await sandbox.release(handle);
    expect(seen).toEqual(["/ensure", "/invoke", "/status", "/release"]);
  });

  it("maps a non-2xx invoke to a transport failure", async () => {
    const baseUrl = await startServer(() => ({ status: 503, json: { error: "overloaded" } }));
    const transport = new HttpRemoteSandboxTransport({ baseUrl });
    const outcome = await transport.invoke({
      sandboxId: "s",
      capability: "exec.run",
      args: {},
      idempotencyKey: "k1",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("UNAVAILABLE");
    }
  });

  it("times out a hanging request", async () => {
    const baseUrl = await startServer(() => "hang");
    const transport = new HttpRemoteSandboxTransport({ baseUrl, timeoutMs: 50 });
    const outcome = await transport.invoke({
      sandboxId: "s",
      capability: "exec.run",
      args: {},
      idempotencyKey: "k1",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("TIMEOUT");
    }
  });
});
