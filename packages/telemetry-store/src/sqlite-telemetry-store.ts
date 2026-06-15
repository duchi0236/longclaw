// SQLite telemetry store: persists the runtime events that matter for tool
// quality, then aggregates them into a ranking. This is the data backbone of
// "tool purification" — deprecating weak tools and polishing hot ones is a
// decision driven by these numbers, not by feel. The runtime emits the
// events; nothing in a brain or a tool writes telemetry itself.

import type { DatabaseSync } from "node:sqlite";
import type { RuntimeEvent, RuntimeEventSink } from "../../loop-runtime/src/index.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS telemetry_tool_calls (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  is_error INTEGER NOT NULL,
  replayed INTEGER NOT NULL,
  duration_ms REAL NOT NULL,
  ts INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS telemetry_approvals (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  risk_class TEXT NOT NULL,
  decision TEXT NOT NULL,
  ts INTEGER NOT NULL
) STRICT;
`;

/** Per-capability quality metrics aggregated across recorded tool calls. */
export interface ToolQuality {
  capability: string;
  calls: number;
  errors: number;
  /** errors / calls, 0 when there are no calls. */
  errorRate: number;
  replays: number;
  avgDurationMs: number;
}

/** Per-capability approval outcomes. */
export interface ApprovalStat {
  capability: string;
  asked: number;
  denied: number;
  /** denied / asked, 0 when nothing was asked. */
  denyRate: number;
}

/** Durable telemetry store over a caller-owned node:sqlite database. The
 * runtime's event sink writes here; the ranking queries read back. */
export class SqliteTelemetryStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = () => Date.now(),
  ) {
    db.exec(SCHEMA);
  }

  /** Records one runtime event; non-tool-quality events are ignored. */
  record(event: RuntimeEvent): void {
    if (event.kind === "tool_call_finished") {
      this.db
        .prepare(
          "INSERT INTO telemetry_tool_calls (session_id, capability, is_error, replayed, duration_ms, ts) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          event.sessionId,
          event.capability,
          event.isError ? 1 : 0,
          event.replayed ? 1 : 0,
          event.durationMs,
          this.now(),
        );
    } else if (event.kind === "approval_resolved") {
      this.db
        .prepare(
          "INSERT INTO telemetry_approvals (session_id, capability, risk_class, decision, ts) VALUES (?, ?, ?, ?, ?)",
        )
        .run(event.sessionId, event.capability, event.riskClass, event.decision, this.now());
    }
  }

  /** Returns a sink that records events; wire it to the runtime telemetry. */
  asSink(): RuntimeEventSink {
    return (event) => this.record(event);
  }

  /** Aggregates recorded tool calls into a per-capability quality ranking,
   * busiest first. The list weak tools sink to the bottom of. */
  toolQualityRanking(): ToolQuality[] {
    const rows = this.db
      .prepare(
        `SELECT capability,
            COUNT(*) AS calls,
            SUM(is_error) AS errors,
            SUM(replayed) AS replays,
            AVG(duration_ms) AS avg_duration_ms
         FROM telemetry_tool_calls
         GROUP BY capability
         ORDER BY calls DESC, capability ASC`,
      )
      .all() as {
      capability: string;
      calls: number;
      errors: number;
      replays: number;
      avg_duration_ms: number;
    }[];
    return rows.map((row) => ({
      capability: row.capability,
      calls: row.calls,
      errors: row.errors,
      errorRate: row.calls > 0 ? row.errors / row.calls : 0,
      replays: row.replays,
      avgDurationMs: row.avg_duration_ms,
    }));
  }

  /** Aggregates approval outcomes per capability. */
  approvalStats(): ApprovalStat[] {
    const rows = this.db
      .prepare(
        `SELECT capability,
            COUNT(*) AS asked,
            SUM(CASE WHEN decision = 'user-denied' OR decision = 'deny' THEN 1 ELSE 0 END) AS denied
         FROM telemetry_approvals
         GROUP BY capability
         ORDER BY asked DESC, capability ASC`,
      )
      .all() as { capability: string; asked: number; denied: number }[];
    return rows.map((row) => ({
      capability: row.capability,
      asked: row.asked,
      denied: row.denied,
      denyRate: row.asked > 0 ? row.denied / row.asked : 0,
    }));
  }
}
