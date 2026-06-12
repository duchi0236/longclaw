// Brain contract types: the boundary between pluggable decision modules
// ("brains") and the neutral loop runtime that hosts them. A brain is pure
// decision logic — no storage, no network, no filesystem. Its only IO door is
// the inference port the runtime injects into each context.

import type { CapabilityManifest } from "../../capability-contract/src/index.js";

/** Identity and requirements of one brain build. */
export interface BrainDescriptor {
  /** Stable brain id, e.g. "standard" | "deep" | "orchestrator". */
  id: string;
  /** Semver of this brain build; used for canary rollout and rollback. */
  version: string;
  /** Optional display name shown in product surfaces. */
  displayName?: string;
  /**
   * Capability name patterns this brain needs to function (exact names or
   * family wildcards like `fs.*`). The runtime refuses to load a brain whose
   * requirements the session snapshot cannot satisfy.
   */
  capabilitiesRequired: string[];
}

/** Remaining budget for the current turn. Null means unlimited. */
export interface TurnBudget {
  tokensLeft: number | null;
  toolCallsLeft: number | null;
  wallClockMsLeft: number | null;
}

/** Mode parameters the product layer selects (standard/deep/team tiers). */
export interface ModeConfig {
  /** Mode id, e.g. "standard" | "deep" | "team". */
  id: string;
  /** Upper bound on concurrently running tool calls. */
  maxParallelToolCalls: number;
  /** Whether the runtime persists and replays plan state for this mode. */
  planningEnabled: boolean;
  /** Free-form mode tuning parameters. */
  params?: Record<string, unknown>;
}

/** One entry in the conversation visible to the brain. */
export type ConversationEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "system"; text: string }
  | { kind: "tool_call"; callId: string; capability: string; args: unknown }
  | { kind: "tool_result"; callId: string; capability: string; isError: boolean; output: string };

/** A single step in a deep-mode plan. */
export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done" | "failed";
}

/** Persistent plan state owned by the runtime, updated via plan actions. */
export interface PlanState {
  revision: number;
  steps: PlanStep[];
}

/** Replacement plan emitted by a brain. Revision must increase by exactly 1. */
export interface PlanUpdate {
  revision: number;
  steps: PlanStep[];
}

/** Request the brain sends through the injected inference port. */
export interface InferenceRequest {
  /** Logical model tier; the runtime maps tiers to concrete models. */
  tier: "fast" | "strong";
  system?: string;
  prompt: string;
}

/** Result returned by the inference port. */
export interface InferenceResult {
  text: string;
  tokensUsed: number;
}

/**
 * The brain's only IO door, injected by the runtime. The runtime wraps it to
 * meter token budget and capture telemetry — brains never see credentials,
 * endpoints, or transport.
 */
export type InferencePort = (request: InferenceRequest) => Promise<InferenceResult>;

/** Specification of a subtask spawned by an orchestrator brain. */
export interface SubtaskSpec {
  title: string;
  instructions: string;
  /** Brain id the subtask should run with; defaults to the parent's. */
  brainId?: string;
  /** Capability patterns the subtask is limited to. */
  capabilityPatterns?: string[];
}

/** Question the brain wants the user to answer before continuing. */
export interface Elicitation {
  question: string;
  options?: string[];
}

/** Everything the runtime hands a brain to decide the next action. */
export interface BrainContext {
  sessionId: string;
  entries: readonly ConversationEntry[];
  capabilities: readonly CapabilityManifest[];
  plan?: PlanState;
  budget: TurnBudget;
  mode: ModeConfig;
  infer: InferencePort;
}

/** The next thing the runtime should do on the brain's behalf. */
export type BrainAction =
  | {
      kind: "tool_call";
      capability: string;
      args: unknown;
      /** Caller-chosen key making retries safe; unique per logical call. */
      idempotencyKey: string;
    }
  | { kind: "respond"; text: string }
  | { kind: "plan"; plan: PlanUpdate }
  | { kind: "spawn"; subtask: SubtaskSpec }
  | { kind: "ask_user"; elicitation: Elicitation }
  | { kind: "finish"; summary: string };

/**
 * A pluggable decision module. Implementations must be stateless: every piece
 * of state they need arrives in the context, every effect they want leaves as
 * the returned action. This is what makes brains swappable mid-session and
 * replayable in shadow evaluation.
 */
export interface AgentBrain {
  descriptor: BrainDescriptor;
  nextAction(ctx: BrainContext): Promise<BrainAction>;
}
