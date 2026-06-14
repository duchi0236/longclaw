// Brain action validation: the runtime never trusts a brain blindly. Every
// action is checked against the session's capability snapshot and plan state
// before it is executed; violations come back to the brain as errors instead
// of crashing the loop.

import {
  matchesCapabilityPattern,
  type CapabilityManifest,
} from "../../capability-contract/src/index.js";
import type { BrainAction, BrainDescriptor, PlanState } from "./types.js";

/** Result of validating one brain action. */
export type BrainActionValidation = { ok: true } | { ok: false; reason: string };

/** State the validator needs from the runtime. */
export interface BrainActionValidationContext {
  capabilities: readonly CapabilityManifest[];
  plan?: PlanState;
  /** Idempotency keys already used in this session. */
  usedIdempotencyKeys: ReadonlySet<string>;
}

/**
 * Validates a brain action against the session state. The runtime calls this
 * before executing any action; a failed validation becomes an error entry in
 * the conversation so the brain can self-correct on the next step.
 */
export function validateBrainAction(
  action: BrainAction,
  ctx: BrainActionValidationContext,
): BrainActionValidation {
  switch (action.kind) {
    case "tool_call": {
      // The whole batch is validated before any call executes, so a contract
      // violation never leaves a half-executed batch behind.
      if (action.calls.length === 0) {
        return { ok: false, reason: "tool_call requires at least one call" };
      }
      const batchKeys = new Set<string>();
      for (const call of action.calls) {
        if (!call.idempotencyKey) {
          return { ok: false, reason: "every call requires a non-empty idempotencyKey" };
        }
        if (
          batchKeys.has(call.idempotencyKey) ||
          ctx.usedIdempotencyKeys.has(call.idempotencyKey)
        ) {
          return {
            ok: false,
            reason: `idempotencyKey "${call.idempotencyKey}" was already used in this session`,
          };
        }
        batchKeys.add(call.idempotencyKey);
        if (!ctx.capabilities.some((c) => c.name === call.capability)) {
          return {
            ok: false,
            reason: `capability "${call.capability}" is not in this session's snapshot`,
          };
        }
      }
      return { ok: true };
    }
    case "plan": {
      const expected = (ctx.plan?.revision ?? 0) + 1;
      if (action.plan.revision !== expected) {
        return {
          ok: false,
          reason: `plan revision must be ${expected}, got ${action.plan.revision}`,
        };
      }
      if (action.plan.steps.length === 0) {
        return { ok: false, reason: "plan must contain at least one step" };
      }
      return { ok: true };
    }
    case "respond":
      return action.text.length > 0
        ? { ok: true }
        : { ok: false, reason: "respond requires non-empty text" };
    case "finish":
      return action.summary.length > 0
        ? { ok: true }
        : { ok: false, reason: "finish requires a non-empty summary" };
    case "ask_user":
      return action.elicitation.question.length > 0
        ? { ok: true }
        : { ok: false, reason: "ask_user requires a non-empty question" };
    case "spawn": {
      if (action.subtasks.length === 0) {
        return { ok: false, reason: "spawn requires at least one subtask" };
      }
      if (action.subtasks.some((subtask) => subtask.instructions.length === 0)) {
        return { ok: false, reason: "every subtask requires non-empty instructions" };
      }
      return { ok: true };
    }
  }
}

/**
 * Checks whether a capability snapshot satisfies everything a brain declares
 * it needs. Returns the unmet patterns; empty means the brain can load.
 */
export function unmetBrainRequirements(
  descriptor: BrainDescriptor,
  capabilities: readonly CapabilityManifest[],
): string[] {
  return descriptor.capabilitiesRequired.filter(
    (pattern) => !capabilities.some((c) => matchesCapabilityPattern(c.name, pattern)),
  );
}
