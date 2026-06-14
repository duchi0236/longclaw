// Loop runtime: the neutral host between pluggable brains and sandboxed
// tools. It owns session state, enforces both contracts, meters budgets,
// gates risky calls behind approvals, and emits all telemetry. The runtime
// changes rarely; brains and tools evolve on either side of it.

import {
  SUBTASK_RESULTS_MARKER,
  unmetBrainRequirements,
  validateBrainAction,
  type AgentBrain,
  type BrainAction,
  type BrainContext,
  type ConversationEntry,
  type InferencePort,
  type ModeConfig,
  type PlanState,
  type SubtaskSpec,
} from "../../brain-contract/src/index.js";
import {
  resolveCapabilitySnapshot,
  resolveRiskDecision,
  type CapabilityEntitlements,
  type CapabilityManifest,
  type ExecutionPolicy,
} from "../../capability-contract/src/index.js";
import {
  SandboxUnavailableError,
  type SandboxBinding,
  type SandboxRouter,
} from "../../sandbox-core/src/index.js";
import type { SessionStore } from "../../session-store/src/index.js";
import type { RuntimeEventSink } from "./events.js";

/** Decision interface for "ask"-class calls; UIs route this to any device. */
export interface ApprovalGate {
  decide(request: {
    sessionId: string;
    capability: string;
    riskClass: string;
    args: unknown;
  }): Promise<"allow" | "deny">;
}

/** Hook the team-mode orchestrator uses to run subtasks; optional. */
export type SubtaskRunner = (sessionId: string, spec: SubtaskSpec) => Promise<string>;

/** Static dependencies a runtime instance is built with. */
export interface LoopRuntimeDeps {
  brain: AgentBrain;
  manifests: CapabilityManifest[];
  router: SandboxRouter;
  inference: InferencePort;
  approvalGate: ApprovalGate;
  policy: ExecutionPolicy;
  entitlements?: CapabilityEntitlements;
  telemetry?: RuntimeEventSink;
  spawnSubtask?: SubtaskRunner;
  /**
   * Durable session storage. Without it sessions are process-local; with it
   * any runtime instance can resume a session from the store.
   */
  store?: SessionStore;
  /** Hard cap on brain steps per turn, independent of budgets. */
  maxStepsPerTurn?: number;
}

/** Inputs for one turn of one session. */
export interface TurnInput {
  sessionId: string;
  userMessage: string;
  binding: SandboxBinding;
  mode: ModeConfig;
  budget?: { tokens?: number; toolCalls?: number };
}

/** Why a turn ended. */
export type TurnStatus = "finished" | "awaiting-user" | "suspended" | "budget-exhausted" | "error";

/** Result of one turn. */
export interface TurnResult {
  status: TurnStatus;
  /** Final summary when status is "finished". */
  summary?: string;
  /** Question for the user when status is "awaiting-user". */
  question?: string;
  /** Assistant responses produced during the turn, in order. */
  responses: string[];
  /** Detail for suspended/error statuses. */
  detail?: string;
}

interface SessionState {
  entries: ConversationEntry[];
  plan?: PlanState;
  usedIdempotencyKeys: Set<string>;
}

const DEFAULT_MAX_STEPS_PER_TURN = 64;

class TokenBudgetExhausted extends Error {
  constructor() {
    super("token budget exhausted");
    this.name = "TokenBudgetExhausted";
  }
}

/** Hosts one brain over one sandbox router for any number of sessions. */
export class LoopRuntime {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly deps: LoopRuntimeDeps) {}

  /** Read-only view of a session's conversation, for storage and tests. */
  sessionEntries(sessionId: string): readonly ConversationEntry[] {
    return this.sessions.get(sessionId)?.entries ?? [];
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const { deps } = this;
    const emit = deps.telemetry ?? (() => {});
    const session = await this.sessionFor(input.sessionId);
    const responses: string[] = [];
    // Single persistence point: every entry visible to the brain is durable
    // before the loop moves on, so a crashed turn resumes consistently.
    const append = async (entry: ConversationEntry): Promise<void> => {
      session.entries.push(entry);
      await deps.store?.appendEntries(input.sessionId, [entry]);
    };

    let tokensLeft = input.budget?.tokens ?? null;
    let toolCallsLeft = input.budget?.toolCalls ?? null;
    let tokensUsed = 0;
    let toolCalls = 0;

    emit({
      kind: "turn_started",
      sessionId: input.sessionId,
      brainId: deps.brain.descriptor.id,
      brainVersion: deps.brain.descriptor.version,
      mode: input.mode.id,
    });

    const finishTurn = (result: TurnResult): TurnResult => {
      emit({
        kind: "turn_finished",
        sessionId: input.sessionId,
        status: result.status,
        toolCalls,
        tokensUsed,
      });
      return result;
    };

    const lease = await deps.router.acquire(input.sessionId, input.binding);
    const snapshot = resolveCapabilitySnapshot({
      manifests: deps.manifests,
      sandbox: { kind: lease.handle.kind, primitives: lease.handle.primitives },
      entitlements: deps.entitlements,
    });

    const unmet = unmetBrainRequirements(deps.brain.descriptor, snapshot.capabilities);
    if (unmet.length > 0) {
      return finishTurn({
        status: "error",
        responses,
        detail: `brain requirements unmet for this sandbox: ${unmet.join(", ")}`,
      });
    }

    await append({ kind: "user", text: input.userMessage });

    const meteredInfer: InferencePort = async (request) => {
      if (tokensLeft !== null && tokensLeft <= 0) {
        throw new TokenBudgetExhausted();
      }
      const result = await deps.inference(request);
      tokensUsed += result.tokensUsed;
      if (tokensLeft !== null) {
        tokensLeft -= result.tokensUsed;
      }
      emit({
        kind: "inference_finished",
        sessionId: input.sessionId,
        tier: request.tier,
        tokensUsed: result.tokensUsed,
      });
      return result;
    };

    const maxSteps = deps.maxStepsPerTurn ?? DEFAULT_MAX_STEPS_PER_TURN;
    for (let step = 0; step < maxSteps; step++) {
      if (tokensLeft !== null && tokensLeft <= 0) {
        return finishTurn({ status: "budget-exhausted", responses, detail: "tokens" });
      }

      const ctx: BrainContext = {
        sessionId: input.sessionId,
        entries: [...session.entries],
        capabilities: snapshot.capabilities,
        ...(session.plan ? { plan: session.plan } : {}),
        budget: {
          tokensLeft,
          toolCallsLeft,
          wallClockMsLeft: null,
        },
        mode: input.mode,
        infer: meteredInfer,
      };

      let action: BrainAction;
      try {
        action = await deps.brain.nextAction(ctx);
      } catch (error) {
        if (error instanceof TokenBudgetExhausted) {
          return finishTurn({ status: "budget-exhausted", responses, detail: "tokens" });
        }
        throw error;
      }
      emit({ kind: "brain_action", sessionId: input.sessionId, action: action.kind });

      const validation = validateBrainAction(action, {
        capabilities: snapshot.capabilities,
        ...(session.plan ? { plan: session.plan } : {}),
        usedIdempotencyKeys: session.usedIdempotencyKeys,
      });
      if (!validation.ok) {
        emit({
          kind: "action_rejected",
          sessionId: input.sessionId,
          action: action.kind,
          reason: validation.reason,
        });
        await append({ kind: "system", text: `action rejected: ${validation.reason}` });
        continue;
      }

      switch (action.kind) {
        case "respond": {
          await append({ kind: "assistant", text: action.text });
          responses.push(action.text);
          break;
        }
        case "plan": {
          session.plan = { revision: action.plan.revision, steps: action.plan.steps };
          await deps.store?.savePlan(input.sessionId, session.plan);
          break;
        }
        case "ask_user": {
          return finishTurn({
            status: "awaiting-user",
            responses,
            question: action.elicitation.question,
          });
        }
        case "finish": {
          return finishTurn({ status: "finished", responses, summary: action.summary });
        }
        case "spawn": {
          if (!deps.spawnSubtask) {
            await append({
              kind: "system",
              text: "spawn rejected: subtasks are not enabled for this runtime",
            });
            break;
          }
          const runner = deps.spawnSubtask;
          // Subtasks run in parallel — the orchestration payoff. Results are
          // reported back as one marked system entry the brain synthesizes.
          const results = await Promise.all(
            action.subtasks.map(async (spec) => {
              const outcome = await runner(input.sessionId, spec);
              return `- ${spec.title}: ${outcome}`;
            }),
          );
          await append({
            kind: "system",
            text: `${SUBTASK_RESULTS_MARKER}\n${results.join("\n")}`,
          });
          break;
        }
        case "tool_call": {
          // One assistant decision: optional text plus a batch of calls,
          // mirroring how one model message carries text and tool calls.
          if (action.text) {
            await append({ kind: "assistant", text: action.text });
            responses.push(action.text);
          }
          // Calls execute sequentially in model order; denials skip a call
          // but never abort the rest of the batch, matching agent-core.
          for (const call of action.calls) {
            if (toolCallsLeft !== null && toolCallsLeft <= 0) {
              return finishTurn({ status: "budget-exhausted", responses, detail: "tool calls" });
            }
            const manifest = snapshot.capabilities.find((c) => c.name === call.capability);
            if (!manifest) {
              // Unreachable: validation checked snapshot membership.
              await append({
                kind: "system",
                text: `action rejected: unknown capability ${call.capability}`,
              });
              continue;
            }

            const decision = resolveRiskDecision(manifest.riskClass, deps.policy);
            if (decision === "deny") {
              emit({
                kind: "approval_resolved",
                sessionId: input.sessionId,
                capability: call.capability,
                riskClass: manifest.riskClass,
                decision: "deny",
              });
              await append({
                kind: "system",
                text: `tool call denied by ${deps.policy} policy: ${call.capability}`,
              });
              continue;
            }
            if (decision === "ask") {
              const verdict = await deps.approvalGate.decide({
                sessionId: input.sessionId,
                capability: call.capability,
                riskClass: manifest.riskClass,
                args: call.args,
              });
              emit({
                kind: "approval_resolved",
                sessionId: input.sessionId,
                capability: call.capability,
                riskClass: manifest.riskClass,
                decision: verdict === "allow" ? "user-allowed" : "user-denied",
              });
              if (verdict === "deny") {
                await append({
                  kind: "system",
                  text: `tool call denied by user: ${call.capability}`,
                });
                continue;
              }
            } else {
              emit({
                kind: "approval_resolved",
                sessionId: input.sessionId,
                capability: call.capability,
                riskClass: manifest.riskClass,
                decision: "allow",
              });
            }

            toolCalls += 1;
            if (toolCallsLeft !== null) {
              toolCallsLeft -= 1;
            }
            const callId = `${input.sessionId}:${session.usedIdempotencyKeys.size + 1}`;
            session.usedIdempotencyKeys.add(call.idempotencyKey);
            await append({
              kind: "tool_call",
              callId,
              capability: call.capability,
              args: call.args,
              idempotencyKey: call.idempotencyKey,
            });

            const startedAt = performance.now();
            try {
              const result = await lease.provider.invoke(lease.handle, {
                callId,
                capability: call.capability,
                args: call.args,
                idempotencyKey: call.idempotencyKey,
              });
              emit({
                kind: "tool_call_finished",
                sessionId: input.sessionId,
                capability: call.capability,
                isError: result.isError,
                replayed: result.replayed ?? false,
                durationMs: performance.now() - startedAt,
              });
              await append({
                kind: "tool_result",
                callId,
                capability: call.capability,
                isError: result.isError,
                output: result.output,
              });
            } catch (error) {
              if (error instanceof SandboxUnavailableError) {
                const detail = error.message;
                emit({ kind: "sandbox_suspended", sessionId: input.sessionId, detail });
                await append({
                  kind: "tool_result",
                  callId,
                  capability: call.capability,
                  isError: true,
                  output: `sandbox unavailable; session suspended (${detail})`,
                });
                return finishTurn({ status: "suspended", responses, detail });
              }
              throw error;
            }
          }
          break;
        }
      }
    }

    return finishTurn({
      status: "budget-exhausted",
      responses,
      detail: `step cap (${maxSteps}) reached`,
    });
  }

  private async sessionFor(sessionId: string): Promise<SessionState> {
    const cached = this.sessions.get(sessionId);
    if (cached) {
      return cached;
    }
    const persisted = await this.deps.store?.load(sessionId);
    // Spent idempotency keys rebuild from the entry log itself, so the store
    // only ever has to persist one append-only stream per session.
    const session: SessionState = persisted
      ? {
          entries: [...persisted.entries],
          ...(persisted.plan ? { plan: persisted.plan } : {}),
          usedIdempotencyKeys: new Set(
            persisted.entries.flatMap((entry) =>
              entry.kind === "tool_call" ? [entry.idempotencyKey] : [],
            ),
          ),
        }
      : { entries: [], usedIdempotencyKeys: new Set() };
    this.sessions.set(sessionId, session);
    return session;
  }
}
