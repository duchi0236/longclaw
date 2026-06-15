// Telemetry store tests: recording runtime events and the aggregated tool
// quality and approval rankings they produce.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../loop-runtime/src/index.js";
import { SqliteTelemetryStore } from "./index.js";

function toolCall(
  capability: string,
  isError: boolean,
  durationMs: number,
  replayed = false,
): RuntimeEvent {
  return { kind: "tool_call_finished", sessionId: "s1", capability, isError, replayed, durationMs };
}

function approval(capability: string, decision: "user-allowed" | "user-denied"): RuntimeEvent {
  return {
    kind: "approval_resolved",
    sessionId: "s1",
    capability,
    riskClass: "execute",
    decision,
  };
}

function freshStore(): SqliteTelemetryStore {
  return new SqliteTelemetryStore(new DatabaseSync(":memory:"));
}

describe("SqliteTelemetryStore tool quality", () => {
  it("aggregates calls, error rate, replays, and average duration per capability", () => {
    const store = freshStore();
    const sink = store.asSink();
    sink(toolCall("fs.read", false, 10));
    sink(toolCall("fs.read", false, 30));
    sink(toolCall("fs.read", true, 20));
    sink(toolCall("exec.run", false, 100, true));

    const ranking = store.toolQualityRanking();
    expect(ranking).toHaveLength(2);

    // Busiest capability first.
    expect(ranking[0]).toMatchObject({
      capability: "fs.read",
      calls: 3,
      errors: 1,
      replays: 0,
      avgDurationMs: 20,
    });
    expect(ranking[0]!.errorRate).toBeCloseTo(1 / 3);

    expect(ranking[1]).toMatchObject({
      capability: "exec.run",
      calls: 1,
      errors: 0,
      replays: 1,
      errorRate: 0,
    });
  });

  it("ignores events that are not tool-quality relevant", () => {
    const store = freshStore();
    store.record({
      kind: "turn_started",
      sessionId: "s1",
      brainId: "standard",
      brainVersion: "1.0.0",
      mode: "standard",
    });
    store.record({ kind: "inference_finished", sessionId: "s1", tier: "fast", tokensUsed: 5 });
    expect(store.toolQualityRanking()).toEqual([]);
  });

  it("surfaces a weak tool by its error rate at the bottom of the ranking", () => {
    const store = freshStore();
    const sink = store.asSink();
    // A heavily used, reliable tool and a rarely used, failing one.
    for (let i = 0; i < 5; i++) {
      sink(toolCall("fs.write", false, 5));
    }
    sink(toolCall("flaky.tool", true, 50));
    sink(toolCall("flaky.tool", true, 50));

    const ranking = store.toolQualityRanking();
    const flaky = ranking.find((r) => r.capability === "flaky.tool");
    expect(flaky?.errorRate).toBe(1);
    expect(ranking[0]!.capability).toBe("fs.write");
  });
});

describe("SqliteTelemetryStore approvals", () => {
  it("aggregates ask and deny counts per capability", () => {
    const store = freshStore();
    const sink = store.asSink();
    sink(approval("exec.run", "user-allowed"));
    sink(approval("exec.run", "user-denied"));
    sink(approval("exec.run", "user-denied"));

    const stats = store.approvalStats();
    expect(stats).toEqual([{ capability: "exec.run", asked: 3, denied: 2, denyRate: 2 / 3 }]);
  });
});

describe("SqliteTelemetryStore durability", () => {
  it("two stores over one database see the same records", () => {
    const db = new DatabaseSync(":memory:");
    new SqliteTelemetryStore(db).record(toolCall("fs.read", false, 12));
    const reader = new SqliteTelemetryStore(db);
    expect(reader.toolQualityRanking()[0]).toMatchObject({ capability: "fs.read", calls: 1 });
  });
});
