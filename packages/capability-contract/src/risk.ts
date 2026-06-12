// Capability risk classification and execution-policy decisions shared by
// brains, the loop runtime, and sandbox providers.

/** Risk classes ordered from least to most dangerous. */
export const CAPABILITY_RISK_CLASSES = ["read", "write", "execute", "destructive"] as const;

/** Risk class assigned to every capability in its manifest. */
export type CapabilityRiskClass = (typeof CAPABILITY_RISK_CLASSES)[number];

/** Per-workspace execution policy selected by the user. */
export const EXECUTION_POLICIES = ["read-only", "ask", "auto"] as const;

/** Execution policy union. */
export type ExecutionPolicy = (typeof EXECUTION_POLICIES)[number];

/** Outcome of combining a capability risk class with an execution policy. */
export type RiskDecision = "allow" | "ask" | "deny";

const RISK_ORDER: Record<CapabilityRiskClass, number> = {
  read: 0,
  write: 1,
  execute: 2,
  destructive: 3,
};

/** Returns true when the value is a known capability risk class. */
export function isCapabilityRiskClass(value: unknown): value is CapabilityRiskClass {
  return (
    typeof value === "string" && (CAPABILITY_RISK_CLASSES as readonly string[]).includes(value)
  );
}

/** Compares two risk classes; negative when `a` is safer than `b`. */
export function compareRiskClass(a: CapabilityRiskClass, b: CapabilityRiskClass): number {
  return RISK_ORDER[a] - RISK_ORDER[b];
}

/** Returns the most dangerous risk class among the provided values. */
export function maxRiskClass(
  first: CapabilityRiskClass,
  ...rest: CapabilityRiskClass[]
): CapabilityRiskClass {
  let max = first;
  for (const risk of rest) {
    if (compareRiskClass(risk, max) > 0) {
      max = risk;
    }
  }
  return max;
}

/**
 * Resolves what the runtime must do before invoking a capability under the
 * given execution policy.
 *
 * - "read-only": only `read` capabilities run; everything else is denied.
 * - "ask": `read` runs unattended; all mutating classes require approval.
 * - "auto": everything runs unattended except `destructive`, which still
 *   requires approval. Allowlists can widen this at the approval layer, never
 *   at this one.
 */
export function resolveRiskDecision(
  risk: CapabilityRiskClass,
  policy: ExecutionPolicy,
): RiskDecision {
  switch (policy) {
    case "read-only":
      return risk === "read" ? "allow" : "deny";
    case "ask":
      return risk === "read" ? "allow" : "ask";
    case "auto":
      return risk === "destructive" ? "ask" : "allow";
  }
}
