// Tool purification: turns the tool-quality ranking into deprecation verdicts.
// This is the "act" end of the collect → evaluate → act loop — a tool whose
// error rate stays high over enough calls is flagged so callers can deny it
// from future sessions. The judgment is data-driven and reversible (it
// deprecates a tool for a session via deny patterns; it does not edit manifests).

import type { ToolQuality } from "./sqlite-telemetry-store.js";

/** Thresholds that decide when a tool is bad enough to deprecate. */
export interface PurificationPolicy {
  /** Minimum calls before a tool is judged, so a single failure can't condemn it. */
  minCalls: number;
  /** Error rate above which a tool is deprecated (0..1). */
  maxErrorRate: number;
}

/** Default thresholds: judge after 3 calls, deprecate above 50% errors. */
export const DEFAULT_PURIFICATION_POLICY: PurificationPolicy = {
  minCalls: 3,
  maxErrorRate: 0.5,
};

/** One deprecation decision with the metric that justified it. */
export interface PurificationVerdict {
  capability: string;
  reason: string;
}

/**
 * Evaluates the ranking against a policy and returns the tools to deprecate.
 * Callers feed the capability names back as session deny patterns so the next
 * session's capability snapshot excludes them.
 */
export function evaluatePurification(
  ranking: ToolQuality[],
  policy: PurificationPolicy = DEFAULT_PURIFICATION_POLICY,
): PurificationVerdict[] {
  return ranking
    .filter((tool) => tool.calls >= policy.minCalls && tool.errorRate > policy.maxErrorRate)
    .map((tool) => ({
      capability: tool.capability,
      reason: `error rate ${Math.round(tool.errorRate * 100)}% over ${tool.calls} calls`,
    }));
}
