// Runtime telemetry events. The runtime is the single place both contract
// boundaries are crossed, so it is the single place telemetry is emitted —
// brains and tools never carry instrumentation code.

import type { BrainAction } from "../../brain-contract/src/types.js";
import type { CapabilityRiskClass, RiskDecision } from "../../capability-contract/src/index.js";

/** One telemetry event emitted by the loop runtime. */
export type RuntimeEvent =
  | { kind: "turn_started"; sessionId: string; brainId: string; brainVersion: string; mode: string }
  | { kind: "brain_action"; sessionId: string; action: BrainAction["kind"] }
  | { kind: "action_rejected"; sessionId: string; action: BrainAction["kind"]; reason: string }
  | {
      kind: "approval_resolved";
      sessionId: string;
      capability: string;
      riskClass: CapabilityRiskClass;
      decision: RiskDecision | "user-denied" | "user-allowed";
    }
  | {
      kind: "tool_call_finished";
      sessionId: string;
      capability: string;
      isError: boolean;
      replayed: boolean;
      durationMs: number;
    }
  | { kind: "inference_finished"; sessionId: string; tier: string; tokensUsed: number }
  | { kind: "sandbox_suspended"; sessionId: string; detail: string }
  | {
      kind: "turn_finished";
      sessionId: string;
      status: string;
      toolCalls: number;
      tokensUsed: number;
    };

/** Telemetry sink the runtime emits into; wire to your pipeline of choice. */
export type RuntimeEventSink = (event: RuntimeEvent) => void;
