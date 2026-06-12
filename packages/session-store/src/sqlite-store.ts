// SQLite-backed session store over node:sqlite, the repo's standard runtime
// storage. The caller owns the database handle and its lifecycle, so this
// store plugs into the per-agent database (openclaw-agent.sqlite) as-is.
// Raw SQL here is limited to bootstrap DDL and three fixed statements; core
// integration goes through the shared Kysely helpers when this is wired in.

import type { DatabaseSync } from "node:sqlite";
import type { ConversationEntry, PlanState } from "../../brain-contract/src/index.js";
import type { PersistedSession, SessionStore } from "./store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS brain_session_entries (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) STRICT;
CREATE TABLE IF NOT EXISTS brain_session_plans (
  session_id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL
) STRICT;
`;

/** Durable session store on a caller-owned node:sqlite database. */
export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA);
  }

  load(sessionId: string): Promise<PersistedSession | null> {
    const rows = this.db
      .prepare("SELECT entry_json FROM brain_session_entries WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as { entry_json: string }[];
    const planRow = this.db
      .prepare("SELECT plan_json FROM brain_session_plans WHERE session_id = ?")
      .get(sessionId) as { plan_json: string } | undefined;
    if (rows.length === 0 && !planRow) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      entries: rows.map((row) => JSON.parse(row.entry_json) as ConversationEntry),
      ...(planRow ? { plan: JSON.parse(planRow.plan_json) as PlanState } : {}),
    });
  }

  appendEntries(sessionId: string, entries: ConversationEntry[]): Promise<void> {
    if (entries.length === 0) {
      return Promise.resolve();
    }
    const nextSeqRow = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM brain_session_entries WHERE session_id = ?",
      )
      .get(sessionId) as { next: number };
    const insert = this.db.prepare(
      "INSERT INTO brain_session_entries (session_id, seq, entry_json) VALUES (?, ?, ?)",
    );
    // One transaction per batch keeps resume-time state consistent: either
    // the whole batch is visible after a crash or none of it is.
    this.db.exec("BEGIN");
    try {
      entries.forEach((entry, index) => {
        insert.run(sessionId, nextSeqRow.next + index, JSON.stringify(entry));
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return Promise.resolve();
  }

  savePlan(sessionId: string, plan: PlanState): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO brain_session_plans (session_id, plan_json) VALUES (?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET plan_json = excluded.plan_json",
      )
      .run(sessionId, JSON.stringify(plan));
    return Promise.resolve();
  }
}
