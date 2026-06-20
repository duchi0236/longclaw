// Phase 3 — runtime events → gateway UI events. The loop runtime emits a
// metadata-only event stream (no payload text); this maps the lifecycle events
// the UI cares about (tool calls, approvals, run status) into gateway-shaped
// events. Assistant text is NOT in the event stream — it comes back in the
// GatewayTurnReply.responses — so this adapter intentionally covers lifecycle
// only and ignores internal events (brain_action, inference_finished, …).

import type { RuntimeEvent, RuntimeEventSink } from "../../packages/loop-runtime/src/index.js";

/** Gateway-facing UI event shapes (a small, stable subset). */
export type GatewayUiEvent =
  | { type: "run.started"; sessionId: string; brainId: string; mode: string }
  | { type: "tool.call.completed"; sessionId: string; capability: string; durationMs: number; replayed: boolean }
  | { type: "tool.call.failed"; sessionId: string; capability: string; durationMs: number }
  | { type: "approval.resolved"; sessionId: string; capability: string; riskClass: string; decision: string }
  | { type: "run.completed"; sessionId: string; toolCalls: number; tokensUsed: number }
  | { type: "run.failed"; sessionId: string }
  | { type: "run.suspended"; sessionId: string; detail?: string }
  | { type: "run.awaiting_user"; sessionId: string }
  | { type: "run.budget_exhausted"; sessionId: string };

/** Maps one runtime event to a gateway UI event, or null when it's internal. */
export function mapRuntimeEvent(event: RuntimeEvent): GatewayUiEvent | null {
  switch (event.kind) {
    case "turn_started":
      return { type: "run.started", sessionId: event.sessionId, brainId: event.brainId, mode: event.mode };
    case "tool_call_finished":
      return event.isError
        ? {
            type: "tool.call.failed",
            sessionId: event.sessionId,
            capability: event.capability,
            durationMs: event.durationMs,
          }
        : {
            type: "tool.call.completed",
            sessionId: event.sessionId,
            capability: event.capability,
            durationMs: event.durationMs,
            replayed: event.replayed ?? false,
          };
    case "approval_resolved":
      return {
        type: "approval.resolved",
        sessionId: event.sessionId,
        capability: event.capability,
        riskClass: event.riskClass,
        decision: event.decision,
      };
    case "sandbox_suspended":
      return { type: "run.suspended", sessionId: event.sessionId, detail: event.detail };
    case "turn_finished":
      switch (event.status) {
        case "finished":
          return {
            type: "run.completed",
            sessionId: event.sessionId,
            toolCalls: event.toolCalls,
            tokensUsed: event.tokensUsed,
          };
        case "error":
          return { type: "run.failed", sessionId: event.sessionId };
        case "suspended":
          return { type: "run.suspended", sessionId: event.sessionId };
        case "awaiting-user":
          return { type: "run.awaiting_user", sessionId: event.sessionId };
        case "budget-exhausted":
          return { type: "run.budget_exhausted", sessionId: event.sessionId };
        default:
          return null;
      }
    // brain_action, action_rejected, inference_finished are internal/metadata.
    default:
      return null;
  }
}

/** Wraps a UI-event emitter as a RuntimeEventSink for the loop runtime. */
export function createGatewayEventSink(emit: (event: GatewayUiEvent) => void): RuntimeEventSink {
  return (event) => {
    const mapped = mapRuntimeEvent(event);
    if (mapped) {
      emit(mapped);
    }
  };
}
