// web.fetch capability tests: LocalSandbox against an injected fetch (success,
// byte-cap truncation, scheme rejection, timeout, idempotency replay), the
// MemorySandbox scripted twin, and the client-node protocol round-trip.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  capabilityToNodeCommand,
  nodeResultToCapability,
} from "./client-node-protocol.js";
import { LocalSandbox, type FetchLike, type SearchLike } from "./local-sandbox.js";
import { MemorySandbox } from "./memory-sandbox.js";
import type { CapabilityInvocation } from "./provider.js";

const roots: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "web-fetch-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function call(capability: string, args: unknown, key: string): CapabilityInvocation {
  return { callId: `c-${key}`, capability, args, idempotencyKey: key };
}

/** A fetch fake that records calls and returns a scripted Response. */
function fakeFetch(
  response: () => Response,
): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    calls.push(url);
    return Promise.resolve(response());
  };
  return { fetchImpl, calls };
}

describe("LocalSandbox web.fetch", () => {
  it("fetches a url and returns the response body", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () => new Response("hello world", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const sandbox = new LocalSandbox({ workspaceRoot: workspace(), fetchImpl });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });

    const result = await sandbox.invoke(
      handle,
      call("web.fetch", { url: "https://example.com/" }, "k1"),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toBe("hello world");
    expect(calls).toEqual(["https://example.com/"]);
    expect((result.details as { status: number }).status).toBe(200);
  });

  it("advertises the net primitive so web.fetch resolves", async () => {
    const sandbox = new LocalSandbox({ workspaceRoot: workspace() });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });
    expect(handle.primitives).toContain("net");
  });

  it("truncates the body at the byte cap", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("0123456789", { status: 200 }));
    const sandbox = new LocalSandbox({ workspaceRoot: workspace(), fetchImpl, maxFetchBytes: 4 });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });

    const result = await sandbox.invoke(
      handle,
      call("web.fetch", { url: "https://example.com/big" }, "k1"),
    );

    expect(result.output).toBe("0123\n[output truncated]");
    expect((result.details as { truncated: boolean }).truncated).toBe(true);
  });

  it("rejects non-http(s) schemes without calling fetch", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response("nope"));
    const sandbox = new LocalSandbox({ workspaceRoot: workspace(), fetchImpl });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });

    const result = await sandbox.invoke(
      handle,
      call("web.fetch", { url: "file:///etc/passwd" }, "k1"),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/unsupported url scheme/);
    expect(calls).toEqual([]);
  });

  it("surfaces non-2xx responses as errors", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("missing", { status: 404 }));
    const sandbox = new LocalSandbox({ workspaceRoot: workspace(), fetchImpl });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });

    const result = await sandbox.invoke(
      handle,
      call("web.fetch", { url: "https://example.com/x" }, "k1"),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/http 404/);
  });

  it("reports a clear error when the request times out", async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const sandbox = new LocalSandbox({ workspaceRoot: workspace(), fetchImpl });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });

    const result = await sandbox.invoke(
      handle,
      call("web.fetch", { url: "https://example.com/slow", timeoutMs: 5 }, "k1"),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/timed out/);
  });

  it("replays a repeated idempotency key without re-fetching", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response("once", { status: 200 }));
    const sandbox = new LocalSandbox({ workspaceRoot: workspace(), fetchImpl });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });

    const first = await sandbox.invoke(handle, call("web.fetch", { url: "https://e.com" }, "dup"));
    const second = await sandbox.invoke(handle, call("web.fetch", { url: "https://e.com" }, "dup"));

    expect(calls).toHaveLength(1);
    expect(second.output).toBe(first.output);
    expect(second.replayed).toBe(true);
  });
});

describe("MemorySandbox web.fetch", () => {
  it("runs the scripted web handler and records the invocation", async () => {
    const sandbox = new MemorySandbox({
      webScript: (url) => ({ output: `body-for:${url}` }),
    });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });

    const result = await sandbox.invoke(
      handle,
      call("web.fetch", { url: "https://api.test/data" }, "k1"),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toBe("body-for:https://api.test/data");
    expect(handle.primitives).toContain("net");
  });

  it("requires a url", async () => {
    const sandbox = new MemorySandbox();
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });
    const result = await sandbox.invoke(handle, call("web.fetch", {}, "k1"));
    expect(result.isError).toBe(true);
  });
});

describe("LocalSandbox web.search", () => {
  const backend: SearchLike = (query, options) =>
    Promise.resolve(
      Array.from({ length: 3 }, (_v, i) => ({
        title: `Result ${i + 1} for ${query}`,
        url: `https://example.com/${i + 1}`,
        snippet: `snippet ${i + 1}`,
      })).slice(0, options.limit),
    );

  it("formats ranked results from the backend", async () => {
    const sandbox = new LocalSandbox({ workspaceRoot: workspace(), searchImpl: backend });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });

    const result = await sandbox.invoke(
      handle,
      call("web.search", { query: "openclaw" }, "k1"),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("1. Result 1 for openclaw — https://example.com/1");
    expect(result.output).toContain("snippet 1");
    expect((result.details as { count: number }).count).toBe(3);
  });

  it("honors the result limit", async () => {
    const sandbox = new LocalSandbox({ workspaceRoot: workspace(), searchImpl: backend });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });

    const result = await sandbox.invoke(
      handle,
      call("web.search", { query: "x", limit: 1 }, "k1"),
    );

    expect((result.details as { count: number }).count).toBe(1);
    expect(result.output.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(1);
  });

  it("errors clearly when no search backend is configured", async () => {
    const sandbox = new LocalSandbox({ workspaceRoot: workspace() });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });

    const result = await sandbox.invoke(handle, call("web.search", { query: "q" }, "k1"));

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/no search backend/);
  });

  it("requires a query", async () => {
    const sandbox = new LocalSandbox({ workspaceRoot: workspace(), searchImpl: backend });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });
    const result = await sandbox.invoke(handle, call("web.search", { query: "  " }, "k1"));
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/requires a query/);
  });
});

describe("MemorySandbox web.search", () => {
  it("runs the scripted search handler", async () => {
    const sandbox = new MemorySandbox({
      searchScript: (query, { limit }) => ({ output: `hits(${limit}):${query}` }),
    });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });
    const result = await sandbox.invoke(handle, call("web.search", { query: "ai", limit: 3 }, "k1"));
    expect(result.output).toBe("hits(3):ai");
  });
});

describe("client-node protocol web.search", () => {
  it("maps a web.search invocation to a node command", () => {
    const command = capabilityToNodeCommand("web.search", { query: "ai", limit: 2 });
    expect(command.command).toBe("web.search");
    expect(command.params).toMatchObject({ query: "ai", limit: 2 });
  });

  it("parses ranked node results", () => {
    const result = nodeResultToCapability("web.search", {
      results: [
        { title: "A", url: "https://a.test", snippet: "sa" },
        { title: "B", url: "https://b.test" },
      ],
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("1. A — https://a.test");
    expect(result.output).toContain("2. B — https://b.test");
  });

  it("parses an error node result", () => {
    const result = nodeResultToCapability("web.search", { error: "rate limited" });
    expect(result.isError).toBe(true);
    expect(result.output).toBe("rate limited");
  });
});

describe("client-node protocol web.fetch", () => {
  it("maps a web.fetch invocation to a node command", () => {
    const command = capabilityToNodeCommand("web.fetch", {
      url: "https://example.com",
      maxBytes: 100,
      timeoutMs: 2000,
    });
    expect(command.command).toBe("web.fetch");
    expect(command.timeoutMs).toBe(2000);
    expect(command.params).toMatchObject({ url: "https://example.com", maxBytes: 100 });
  });

  it("parses a successful node result", () => {
    const result = nodeResultToCapability("web.fetch", {
      ok: true,
      status: 200,
      body: "device body",
    });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("device body");
  });

  it("parses a failed node result as an error", () => {
    const result = nodeResultToCapability("web.fetch", { ok: false, status: 500, error: "boom" });
    expect(result.isError).toBe(true);
    expect(result.output).toBe("boom");
  });

  it("marks truncated bodies", () => {
    const result = nodeResultToCapability("web.fetch", {
      ok: true,
      status: 200,
      body: "partial",
      truncated: true,
    });
    expect(result.output).toBe("partial\n[output truncated]");
  });
});
