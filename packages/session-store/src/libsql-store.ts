// libSQL (Turso) session store: the central, online conversation store. The
// same client API targets a local file (`file:`), an in-memory db, or a remote
// Turso database (`libsql://…`) — so the code is identical from local dev to
// production; only the URL changes. Sessions carry an owner for multi-tenancy,
// which makes runtime instances stateless: any instance loads any session from
// the shared database, and a user sees the same conversation on every device.

import { createClient, type Client } from "@libsql/client";
import type { ConversationEntry, PlanState } from "../../brain-contract/src/index.js";
import type { CentralSessionStore, PersistedSession, SessionSummary } from "./store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS brain_sessions (
  session_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS brain_session_entries (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS brain_session_plans (
  session_id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner
  ON brain_sessions (owner_user_id, updated_at DESC);
`;

/** Connection config for the central store. */
export interface LibsqlStoreConfig {
  /** `file:path`, `:memory:`, or `libsql://<db>.turso.io`. */
  url: string;
  /** Auth token for a remote Turso database. */
  authToken?: string;
}

/** Central session store over a libSQL/Turso database. */
export class LibsqlSessionStore implements CentralSessionStore {
  constructor(
    private readonly client: Client,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Connects, creates the schema, and returns the store plus a closer. */
  static async create(
    config: LibsqlStoreConfig,
    now: () => number = () => Date.now(),
  ): Promise<{ store: LibsqlSessionStore; close: () => void }> {
    const client = createClient(
      config.authToken ? { url: config.url, authToken: config.authToken } : { url: config.url },
    );
    await client.executeMultiple(SCHEMA);
    return { store: new LibsqlSessionStore(client, now), close: () => client.close() };
  }

  async ensureSession(sessionId: string, ownerUserId: string): Promise<void> {
    const ts = this.now();
    await this.client.execute(
      "INSERT INTO brain_sessions (session_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING",
      [sessionId, ownerUserId, ts, ts],
    );
  }

  async ownerOf(sessionId: string): Promise<string | null> {
    const rs = await this.client.execute(
      "SELECT owner_user_id FROM brain_sessions WHERE session_id = ?",
      [sessionId],
    );
    const row = rs.rows[0];
    return row ? String(row.owner_user_id) : null;
  }

  async listSessions(ownerUserId: string): Promise<SessionSummary[]> {
    const rs = await this.client.execute(
      "SELECT session_id, updated_at FROM brain_sessions WHERE owner_user_id = ? ORDER BY updated_at DESC",
      [ownerUserId],
    );
    return rs.rows.map((row) => ({
      sessionId: String(row.session_id),
      updatedAt: Number(row.updated_at),
    }));
  }

  async load(sessionId: string): Promise<PersistedSession | null> {
    const entriesRs = await this.client.execute(
      "SELECT entry_json FROM brain_session_entries WHERE session_id = ? ORDER BY seq ASC",
      [sessionId],
    );
    const planRs = await this.client.execute(
      "SELECT plan_json FROM brain_session_plans WHERE session_id = ?",
      [sessionId],
    );
    const planRow = planRs.rows[0];
    if (entriesRs.rows.length === 0 && !planRow) {
      return null;
    }
    return {
      entries: entriesRs.rows.map((row) => JSON.parse(String(row.entry_json)) as ConversationEntry),
      ...(planRow ? { plan: JSON.parse(String(planRow.plan_json)) as PlanState } : {}),
    };
  }

  async appendEntries(sessionId: string, entries: ConversationEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const nextRs = await this.client.execute(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM brain_session_entries WHERE session_id = ?",
      [sessionId],
    );
    const next = Number(nextRs.rows[0]?.next ?? 1);
    // One transaction per batch: a crash leaves the whole batch visible or none,
    // so resume-time idempotency-key recovery never sees a half-written turn.
    const statements: { sql: string; args: (string | number)[] }[] = entries.map(
      (entry, index) => ({
        sql: "INSERT INTO brain_session_entries (session_id, seq, entry_json) VALUES (?, ?, ?)",
        args: [sessionId, next + index, JSON.stringify(entry)],
      }),
    );
    statements.push({
      sql: "UPDATE brain_sessions SET updated_at = ? WHERE session_id = ?",
      args: [this.now(), sessionId],
    });
    await this.client.batch(statements, "write");
  }

  async savePlan(sessionId: string, plan: PlanState): Promise<void> {
    await this.client.execute(
      "INSERT INTO brain_session_plans (session_id, plan_json) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET plan_json = excluded.plan_json",
      [sessionId, JSON.stringify(plan)],
    );
  }
}
