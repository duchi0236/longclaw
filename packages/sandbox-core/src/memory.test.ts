// memory.* capability tests: the in-memory store ranking, the LocalSandbox and
// MemorySandbox capability surface (write/read/search, validation, idempotency),
// and the client-node protocol round-trip.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  capabilityToNodeCommand,
  nodeResultToCapability,
} from "./client-node-protocol.js";
import { LocalSandbox } from "./local-sandbox.js";
import { MemorySandbox } from "./memory-sandbox.js";
import { InMemoryMemoryStore } from "./memory-store.js";
import type { CapabilityInvocation } from "./provider.js";

const roots: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "memory-"));
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

describe("InMemoryMemoryStore", () => {
  it("assigns keys, reads back, and upserts on an explicit key", async () => {
    const store = new InMemoryMemoryStore();
    const a = await store.write({ text: "first note" });
    const b = await store.write({ text: "second note" });
    expect(a.key).not.toBe(b.key);
    expect((await store.read(a.key))?.text).toBe("first note");

    await store.write({ key: a.key, text: "updated" });
    expect((await store.read(a.key))?.text).toBe("updated");
  });

  it("ranks search results by token overlap and caps at the limit", async () => {
    const store = new InMemoryMemoryStore();
    await store.write({ key: "a", text: "the cat sat on the mat" });
    await store.write({ key: "b", text: "a dog barked loudly" });
    await store.write({ key: "c", text: "cat and dog are friends" });

    const hits = await store.search("cat dog", { limit: 5 });
    expect(hits.map((entry) => entry.key)).toEqual(["c", "a", "b"]);

    const capped = await store.search("cat dog", { limit: 1 });
    expect(capped).toHaveLength(1);
    expect(capped[0]?.key).toBe("c");
  });

  it("returns nothing for an empty query or no match", async () => {
    const store = new InMemoryMemoryStore();
    await store.write({ text: "hello" });
    expect(await store.search("   ", { limit: 5 })).toEqual([]);
    expect(await store.search("absent", { limit: 5 })).toEqual([]);
  });
});

describe("LocalSandbox memory.*", () => {
  async function ready() {
    const sandbox = new LocalSandbox({ workspaceRoot: workspace() });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });
    return { sandbox, handle };
  }

  it("advertises the mem primitive", async () => {
    const { handle } = await ready();
    expect(handle.primitives).toContain("mem");
  });

  it("writes, reads back, and searches notes", async () => {
    const { sandbox, handle } = await ready();

    const write = await sandbox.invoke(
      handle,
      call("memory.write", { key: "pref", text: "user prefers dark mode", tags: ["ui"] }, "k1"),
    );
    expect(write.isError).toBe(false);
    expect(write.output).toBe("stored: pref");

    const read = await sandbox.invoke(handle, call("memory.read", { key: "pref" }, "k2"));
    expect(read.output).toBe("user prefers dark mode");

    const search = await sandbox.invoke(handle, call("memory.search", { query: "dark" }, "k3"));
    expect(search.isError).toBe(false);
    expect(search.output).toContain("1. pref: user prefers dark mode [ui]");
  });

  it("errors when reading a missing key", async () => {
    const { sandbox, handle } = await ready();
    const read = await sandbox.invoke(handle, call("memory.read", { key: "nope" }, "k1"));
    expect(read.isError).toBe(true);
    expect(read.output).toMatch(/memory not found/);
  });

  it("validates required inputs", async () => {
    const { sandbox, handle } = await ready();
    const noText = await sandbox.invoke(handle, call("memory.write", { text: "" }, "k1"));
    expect(noText.isError).toBe(true);
    const noKey = await sandbox.invoke(handle, call("memory.read", {}, "k2"));
    expect(noKey.isError).toBe(true);
    const noQuery = await sandbox.invoke(handle, call("memory.search", { query: "" }, "k3"));
    expect(noQuery.isError).toBe(true);
  });

  it("replays a repeated write idempotency key without a second write", async () => {
    const store = new InMemoryMemoryStore();
    const sandbox = new LocalSandbox({ workspaceRoot: workspace(), memoryStore: store });
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });

    const first = await sandbox.invoke(handle, call("memory.write", { text: "note" }, "dup"));
    const second = await sandbox.invoke(handle, call("memory.write", { text: "note" }, "dup"));

    expect(second.replayed).toBe(true);
    expect(second.output).toBe(first.output);
    // Only one entry was actually stored despite two invocations.
    const all = await store.search("note", { limit: 10 });
    expect(all).toHaveLength(1);
  });
});

describe("MemorySandbox memory.*", () => {
  it("uses a store-backed memory family and stays healthy-gated", async () => {
    const sandbox = new MemorySandbox();
    const handle = await sandbox.ensureReady({ kind: "cloud-general" });
    expect(handle.primitives).toContain("mem");

    await sandbox.invoke(handle, call("memory.write", { key: "x", text: "remember me" }, "k1"));
    const read = await sandbox.invoke(handle, call("memory.read", { key: "x" }, "k2"));
    expect(read.output).toBe("remember me");

    const search = await sandbox.invoke(handle, call("memory.search", { query: "remember" }, "k3"));
    expect(search.output).toContain("1. x: remember me");
  });
});

describe("client-node protocol memory.*", () => {
  it("maps memory.write/read/search to node commands", () => {
    expect(capabilityToNodeCommand("memory.write", { text: "t", tags: ["a"] })).toMatchObject({
      command: "memory.write",
      params: { text: "t", tags: ["a"] },
    });
    expect(capabilityToNodeCommand("memory.read", { key: "k" })).toMatchObject({
      command: "memory.read",
      params: { key: "k" },
    });
    expect(capabilityToNodeCommand("memory.search", { query: "q", limit: 3 })).toMatchObject({
      command: "memory.search",
      params: { query: "q", limit: 3 },
    });
  });

  it("parses node results back into capability results", () => {
    expect(nodeResultToCapability("memory.write", { key: "mem-7" }).output).toBe("stored: mem-7");

    const read = nodeResultToCapability("memory.read", { found: true, text: "recalled" });
    expect(read.output).toBe("recalled");
    expect(nodeResultToCapability("memory.read", { found: false }).isError).toBe(true);

    const search = nodeResultToCapability("memory.search", {
      results: [{ key: "a", text: "alpha note", tags: ["t"] }],
    });
    expect(search.output).toContain("1. a: alpha note [t]");
  });
});
