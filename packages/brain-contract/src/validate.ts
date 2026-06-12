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
      if (!action.idempotencyKey) {
        return { ok: false, reason: "tool_call requires a non-empty idempotencyKey" };
      }
      if (ctx.usedIdempotencyKeys.has(action.idempotencyKey)) {
        return {
          ok: false,
          reason: `idempotencyKey "${action.idempotencyKey}" was already used in this session`,
        };
      }
      if (!ctx.capabilities.some((c) => c.name === action.capability)) {
        return {
          ok: false,
          reason: `capability "${action.capability}" is not in this session's snapshot`,
        };
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
    case "spawn":
      return action.subtask.instructions.length > 0
        ? { ok: true }
        : { ok: false, reason: "spawn requires non-empty instructions" };
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
