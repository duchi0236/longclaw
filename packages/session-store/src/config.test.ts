// Config factory tests: validation of untrusted config, backend selection,
// and real on-disk durability across close/reopen.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationEntry } from "../../brain-contract/src/index.js";
import {
  createSessionStore,
  MemorySessionStore,
  SqliteSessionStore,
  validateSessionStoreConfig,
} from "./index.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "session-store-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function entry(text: string): ConversationEntry {
  return { kind: "user", text };
}

describe("validateSessionStoreConfig", () => {
  it("accepts the two known backends", () => {
    expect(validateSessionStoreConfig({ kind: "memory" })).toEqual({
      ok: true,
      config: { kind: "memory" },
    });
    expect(validateSessionStoreConfig({ kind: "sqlite", path: "/tmp/x.sqlite" })).toEqual({
      ok: true,
      config: { kind: "sqlite", path: "/tmp/x.sqlite" },
    });
  });

  it("rejects unknown kinds and missing sqlite paths", () => {
    expect(validateSessionStoreConfig({ kind: "postgres" }).ok).toBe(false);
    expect(validateSessionStoreConfig({ kind: "sqlite" }).ok).toBe(false);
    expect(validateSessionStoreConfig({ kind: "sqlite", path: "" }).ok).toBe(false);
    expect(validateSessionStoreConfig(null).ok).toBe(false);
  });
});

describe("createSessionStore", () => {
  it("builds the backend the config names", () => {
    const memory = createSessionStore({ kind: "memory" });
    expect(memory.store).toBeInstanceOf(MemorySessionStore);
    memory.close();

    const sqlite = createSessionStore({ kind: "sqlite", path: ":memory:" });
    expect(sqlite.store).toBeInstanceOf(SqliteSessionStore);
    sqlite.close();
  });

  it("persists sessions on disk across close and reopen", async () => {
    // Nested directory proves the factory creates missing parents.
    const dbPath = path.join(tempDir(), "agent", "openclaw-agent.sqlite");

    const first = createSessionStore({ kind: "sqlite", path: dbPath });
    await first.store.appendEntries("s1", [entry("survives restarts")]);
    first.close();

    const second = createSessionStore({ kind: "sqlite", path: dbPath });
    const loaded = await second.store.load("s1");
    second.close();

    expect(loaded?.entries).toEqual([entry("survives restarts")]);
  });
});
