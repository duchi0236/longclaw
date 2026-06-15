// Purification tests: the ranking-to-deprecation judgment under the policy
// thresholds (sample floor and error-rate ceiling).
import { describe, expect, it } from "vitest";
import { evaluatePurification, type PurificationPolicy } from "./purification.js";
import type { ToolQuality } from "./sqlite-telemetry-store.js";

function tool(capability: string, calls: number, errorRate: number): ToolQuality {
  return {
    capability,
    calls,
    errors: Math.round(calls * errorRate),
    errorRate,
    replays: 0,
    avgDurationMs: 1,
  };
}

const policy: PurificationPolicy = { minCalls: 3, maxErrorRate: 0.5 };

describe("evaluatePurification", () => {
  it("deprecates a tool that fails too often over enough calls", () => {
    const verdicts = evaluatePurification([tool("flaky.tool", 4, 0.75)], policy);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.capability).toBe("flaky.tool");
    expect(verdicts[0]!.reason).toContain("75%");
  });

  it("spares a failing tool that lacks the minimum sample size", () => {
    expect(evaluatePurification([tool("rare.tool", 2, 1)], policy)).toEqual([]);
  });

  it("spares a well-used tool with an acceptable error rate", () => {
    expect(evaluatePurification([tool("fs.read", 100, 0.1)], policy)).toEqual([]);
  });

  it("returns every tool that crosses the thresholds", () => {
    const verdicts = evaluatePurification(
      [tool("good.tool", 10, 0), tool("bad.one", 5, 0.8), tool("bad.two", 3, 0.6)],
      policy,
    );
    expect(verdicts.map((v) => v.capability)).toEqual(["bad.one", "bad.two"]);
  });
});
