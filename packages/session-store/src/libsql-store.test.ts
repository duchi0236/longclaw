// libSQL central store tests run against a real local libSQL file (the same
// client/SQL as production Turso, only the URL differs). They pin the online
// guarantees: a session written by one instance loads in a fresh instance
// (stateless runtime), sessions are owned (multi-tenant), and a user can list
// their own conversations.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationEntry } from "../../brain-contract/src/index.js";
import { LibsqlSessionStore } from "./libsql-store.js";

const dirs: string[] = [];
function fileUrl(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "libsql-store-"));
  dirs.push(dir);
  return `file:${path.join(dir, "central.db")}`;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function entry(text: string): ConversationEntry {
  return { kind: "user", text };
}

describe("LibsqlSessionStore", () => {
  it("loads in a fresh instance a session another instance wrote (stateless runtime)", async () => {
    const url = fileUrl();

    const a = await LibsqlSessionStore.create({ url });
    await a.store.ensureSession("s1", "user-1");
    await a.store.appendEntries("s1", [entry("from instance A")]);
    a.close();

    // A brand-new instance over the same central database serves the session.
    const b = await LibsqlSessionStore.create({ url });
    const loaded = await b.store.load("s1");
    const owner = await b.store.ownerOf("s1");
    b.close();

    expect(loaded?.entries).toEqual([entry("from instance A")]);
    expect(owner).toBe("user-1");
  });

  it("isolates sessions by owner and lists a user's conversations newest-first", async () => {
    let clock = 1000;
    const { store, close } = await LibsqlSessionStore.create({ url: fileUrl() }, () => clock++);

    await store.ensureSession("s1", "alice");
    await store.ensureSession("s2", "alice");
    await store.ensureSession("s3", "bob");
    await store.appendEntries("s2", [entry("newer")]); // bumps s2's updated_at

    const alice = await store.listSessions("alice");
    const bob = await store.listSessions("bob");
    close();

    expect(alice.map((s) => s.sessionId)).toEqual(["s2", "s1"]); // s2 updated later
    expect(bob.map((s) => s.sessionId)).toEqual(["s3"]);
  });

  it("keeps entry order across append batches and persists the plan", async () => {
    const { store, close } = await LibsqlSessionStore.create({ url: fileUrl() });
    await store.ensureSession("s1", "user-1");
    await store.appendEntries("s1", [entry("one"), entry("two")]);
    await store.appendEntries("s1", [entry("three")]);
    await store.savePlan("s1", {
      revision: 1,
      steps: [{ id: "a", title: "investigate", status: "pending" }],
    });

    const loaded = await store.load("s1");
    close();

    expect(loaded?.entries.map((e) => (e.kind === "user" ? e.text : e.kind))).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(loaded?.plan?.revision).toBe(1);
  });

  it("returns null for an unknown session and null owner", async () => {
    const { store, close } = await LibsqlSessionStore.create({ url: fileUrl() });
    expect(await store.load("missing")).toBeNull();
    expect(await store.ownerOf("missing")).toBeNull();
    close();
  });
});
