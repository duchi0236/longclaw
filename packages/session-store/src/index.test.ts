// Session store tests: both implementations honor the same contract —
// ordered append-only entries, plan replacement, session isolation.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ConversationEntry } from "../../brain-contract/src/index.js";
import { MemorySessionStore, SqliteSessionStore, type SessionStore } from "./index.js";

const stores: [string, () => SessionStore][] = [
  ["MemorySessionStore", () => new MemorySessionStore()],
  ["SqliteSessionStore", () => new SqliteSessionStore(new DatabaseSync(":memory:"))],
];

function entry(text: string): ConversationEntry {
  return { kind: "user", text };
}

describe.each(stores)("%s", (_name, createStore) => {
  it("returns null for sessions that were never written", async () => {
    expect(await createStore().load("missing")).toBeNull();
  });

  it("round-trips entries in append order across batches", async () => {
    const store = createStore();
    await store.appendEntries("s1", [entry("one"), entry("two")]);
    await store.appendEntries("s1", [
      {
        kind: "tool_call",
        callId: "s1:1",
        capability: "fs.read",
        args: { path: "a.txt" },
        idempotencyKey: "k1",
      },
    ]);

    const loaded = await store.load("s1");
    expect(loaded?.entries.map((e) => (e.kind === "user" ? e.text : e.kind))).toEqual([
      "one",
      "two",
      "tool_call",
    ]);
    expect(loaded?.plan).toBeUndefined();
  });

  it("replaces the plan on save", async () => {
    const store = createStore();
    await store.savePlan("s1", {
      revision: 1,
      steps: [{ id: "a", title: "investigate", status: "pending" }],
    });
    await store.savePlan("s1", {
      revision: 2,
      steps: [{ id: "a", title: "investigate", status: "done" }],
    });

    const loaded = await store.load("s1");
    expect(loaded?.plan?.revision).toBe(2);
    expect(loaded?.plan?.steps[0]?.status).toBe("done");
  });

  it("keeps sessions isolated", async () => {
    const store = createStore();
    await store.appendEntries("s1", [entry("for s1")]);
    await store.appendEntries("s2", [entry("for s2")]);

    const s2 = await store.load("s2");
    expect(s2?.entries).toEqual([entry("for s2")]);
  });
});

describe("SqliteSessionStore durability", () => {
  it("two store instances over one database see the same log", async () => {
    const db = new DatabaseSync(":memory:");
    const writer = new SqliteSessionStore(db);
    await writer.appendEntries("s1", [entry("written before restart")]);

    const reader = new SqliteSessionStore(db);
    const loaded = await reader.load("s1");
    expect(loaded?.entries).toEqual([entry("written before restart")]);
  });
});
