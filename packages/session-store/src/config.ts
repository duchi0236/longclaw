// Config-driven session store construction: the seam where a deployment
// chooses its database. Today: in-memory or SQLite at a path (the per-agent
// database convention, agents/<agentId>/agent/openclaw-agent.sqlite). New
// backends extend the closed config union; callers never construct stores
// directly once they go through this factory.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemorySessionStore } from "./memory-store.js";
import { SqliteSessionStore } from "./sqlite-store.js";
import type { SessionStore } from "./store.js";

/** Where session state lives. Closed union: new backends extend it here. */
export type SessionStoreConfig =
  | { kind: "memory" }
  | {
      kind: "sqlite";
      /** Database file path; ":memory:" for an ephemeral database. */
      path: string;
    };

/** A constructed store plus ownership of its underlying resources. */
export interface SessionStoreHandle {
  store: SessionStore;
  /** Releases underlying resources (e.g. the database handle). */
  close(): void;
}

/** Validation result for config arriving from an external boundary. */
export type SessionStoreConfigValidation =
  | { ok: true; config: SessionStoreConfig }
  | { ok: false; errors: string[] };

/** Validates untrusted config (e.g. from a deployment config file). */
export function validateSessionStoreConfig(value: unknown): SessionStoreConfigValidation {
  if (typeof value !== "object" || value === null) {
    return { ok: false, errors: ["session store config must be an object"] };
  }
  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case "memory":
      return { ok: true, config: { kind: "memory" } };
    case "sqlite": {
      if (typeof candidate.path !== "string" || candidate.path.length === 0) {
        return { ok: false, errors: ["sqlite session store requires a non-empty path"] };
      }
      return { ok: true, config: { kind: "sqlite", path: candidate.path } };
    }
    default:
      return { ok: false, errors: ['kind must be "memory" or "sqlite"'] };
  }
}

/** Builds the store a config describes; the caller owns the handle. */
export function createSessionStore(config: SessionStoreConfig): SessionStoreHandle {
  switch (config.kind) {
    case "memory":
      return { store: new MemorySessionStore(), close: () => {} };
    case "sqlite": {
      if (config.path !== ":memory:") {
        mkdirSync(path.dirname(config.path), { recursive: true });
      }
      const db = new DatabaseSync(config.path);
      return { store: new SqliteSessionStore(db), close: () => db.close() };
    }
  }
}
