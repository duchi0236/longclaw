// Capability manifest: the self-description every tool publishes into the
// capability registry. Brains consume manifests; sandbox providers implement
// them. Neither side may depend on the other's code — only on this contract.

import { isCapabilityRiskClass, type CapabilityRiskClass } from "./risk.js";
import { parseSemanticVersion } from "./version.js";

/** Sandbox families a capability can execute in. */
export const SANDBOX_KINDS = ["cloud-general", "cloud-repo", "client-node"] as const;

/** Sandbox kind union. */
export type SandboxKind = (typeof SANDBOX_KINDS)[number];

/** Low-level primitives a sandbox must offer for a capability to run. */
export const SANDBOX_PRIMITIVES = ["fs", "net", "proc", "mem"] as const;

/** Sandbox primitive union. */
export type SandboxPrimitive = (typeof SANDBOX_PRIMITIVES)[number];

/**
 * Capability names are dotted family paths: `fs.read`, `exec.run`,
 * `web.search`. The family segment groups related capabilities for
 * entitlement patterns like `fs.*`.
 */
export const CAPABILITY_NAME_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;

/** Structural JSON Schema type; kept loose on purpose at the contract layer. */
export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** Self-description of one capability, versioned independently of its implementation. */
export interface CapabilityManifest {
  /** Dotted family name, e.g. `fs.read`. */
  name: string;
  /** Semver. Breaking input/output schema changes must bump major. */
  version: string;
  /** Human/brain readable description of what the capability does. */
  description: string;
  /** JSON Schema for the invocation arguments. */
  inputSchema: JsonSchemaObject;
  /** Risk class driving approval behavior. */
  riskClass: CapabilityRiskClass;
  /** Primitives the executing sandbox must provide. */
  sandboxRequires: SandboxPrimitive[];
  /** Sandbox kinds that have an implementation for this capability. */
  providerKinds: SandboxKind[];
  /** Optional display title. */
  title?: string;
  /** Deprecated capabilities are excluded from snapshots by default. */
  deprecated?: boolean;
  /** Extra tags attached to telemetry events for this capability. */
  telemetryTags?: string[];
}

/** Validation result for an untrusted manifest value. */
export type ManifestValidation =
  | { ok: true; manifest: CapabilityManifest }
  | { ok: false; errors: string[] };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Returns true when the value is a known sandbox kind. */
export function isSandboxKind(value: unknown): value is SandboxKind {
  return typeof value === "string" && (SANDBOX_KINDS as readonly string[]).includes(value);
}

/** Returns true when the value is a known sandbox primitive. */
export function isSandboxPrimitive(value: unknown): value is SandboxPrimitive {
  return typeof value === "string" && (SANDBOX_PRIMITIVES as readonly string[]).includes(value);
}

/**
 * Validates an untrusted value as a capability manifest. Collects every
 * problem instead of failing fast so registry rejections are actionable.
 */
export function validateCapabilityManifest(value: unknown): ManifestValidation {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { ok: false, errors: ["manifest must be an object"] };
  }
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.name !== "string" || !CAPABILITY_NAME_PATTERN.test(candidate.name)) {
    errors.push("name must be a dotted family path like `fs.read`");
  }
  if (typeof candidate.version !== "string" || !parseSemanticVersion(candidate.version)) {
    errors.push("version must be valid semver");
  }
  if (typeof candidate.description !== "string" || candidate.description.length === 0) {
    errors.push("description must be a non-empty string");
  }
  const schema = candidate.inputSchema as Record<string, unknown> | undefined;
  if (typeof schema !== "object" || schema === null || schema.type !== "object") {
    errors.push('inputSchema must be a JSON Schema with type "object"');
  }
  if (!isCapabilityRiskClass(candidate.riskClass)) {
    errors.push("riskClass must be one of read|write|execute|destructive");
  }
  if (
    !Array.isArray(candidate.sandboxRequires) ||
    !candidate.sandboxRequires.every(isSandboxPrimitive)
  ) {
    errors.push("sandboxRequires must be an array of fs|net|proc|mem");
  }
  if (
    !Array.isArray(candidate.providerKinds) ||
    candidate.providerKinds.length === 0 ||
    !candidate.providerKinds.every(isSandboxKind)
  ) {
    errors.push("providerKinds must be a non-empty array of known sandbox kinds");
  }
  if (candidate.title !== undefined && typeof candidate.title !== "string") {
    errors.push("title must be a string when present");
  }
  if (candidate.deprecated !== undefined && typeof candidate.deprecated !== "boolean") {
    errors.push("deprecated must be a boolean when present");
  }
  if (candidate.telemetryTags !== undefined && !isStringArray(candidate.telemetryTags)) {
    errors.push("telemetryTags must be an array of strings when present");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, manifest: candidate as unknown as CapabilityManifest };
}

/** Returns the family segment of a capability name (`fs.read` → `fs`). */
export function capabilityFamily(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

/**
 * Matches a capability name against an entitlement pattern: either an exact
 * name (`fs.read`) or a family wildcard (`fs.*`).
 */
export function matchesCapabilityPattern(name: string, pattern: string): boolean {
  if (pattern.endsWith(".*")) {
    return capabilityFamily(name) === pattern.slice(0, -2);
  }
  return name === pattern;
}
