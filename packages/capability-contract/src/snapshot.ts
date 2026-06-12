// Capability snapshot resolution: given everything registered, what can THIS
// session actually use? Inputs are the sandbox binding, the user's
// entitlements, and the mode. Exclusions are recorded, never silent.

import {
  matchesCapabilityPattern,
  type CapabilityManifest,
  type SandboxKind,
  type SandboxPrimitive,
} from "./manifest.js";
import { compareSemanticVersions, parseSemanticVersion } from "./version.js";

/** Description of the sandbox a session is bound to. */
export interface SandboxDescriptor {
  kind: SandboxKind;
  /** Primitives this concrete sandbox instance offers. */
  primitives: SandboxPrimitive[];
}

/** Entitlement filters applied on top of sandbox compatibility. */
export interface CapabilityEntitlements {
  /** When present, only names matching one of these patterns are kept. */
  allowPatterns?: string[];
  /** Names matching any of these patterns are always dropped. */
  denyPatterns?: string[];
}

/** Why a registered capability was left out of a snapshot. */
export type CapabilityExclusionReason =
  | "provider-mismatch"
  | "missing-primitive"
  | "deprecated"
  | "denied"
  | "not-allowed"
  | "superseded"
  | "invalid-version";

/** One excluded capability with the reason, for observability. */
export interface ExcludedCapability {
  name: string;
  version: string;
  reason: CapabilityExclusionReason;
}

/** Inputs to snapshot resolution. */
export interface CapabilityResolutionInput {
  manifests: CapabilityManifest[];
  sandbox: SandboxDescriptor;
  entitlements?: CapabilityEntitlements;
  includeDeprecated?: boolean;
}

/** The resolved, per-session capability surface handed to a brain. */
export interface CapabilitySnapshot {
  capabilities: CapabilityManifest[];
  excluded: ExcludedCapability[];
}

function exclusionReasonFor(
  manifest: CapabilityManifest,
  input: CapabilityResolutionInput,
): CapabilityExclusionReason | null {
  const { sandbox, entitlements, includeDeprecated } = input;
  if (!parseSemanticVersion(manifest.version)) {
    return "invalid-version";
  }
  if (entitlements?.denyPatterns?.some((p) => matchesCapabilityPattern(manifest.name, p))) {
    return "denied";
  }
  if (
    entitlements?.allowPatterns &&
    !entitlements.allowPatterns.some((p) => matchesCapabilityPattern(manifest.name, p))
  ) {
    return "not-allowed";
  }
  if (!manifest.providerKinds.includes(sandbox.kind)) {
    return "provider-mismatch";
  }
  if (!manifest.sandboxRequires.every((primitive) => sandbox.primitives.includes(primitive))) {
    return "missing-primitive";
  }
  if (manifest.deprecated && !includeDeprecated) {
    return "deprecated";
  }
  return null;
}

/**
 * Resolves the capability snapshot for one session. Multiple registered
 * versions of the same capability collapse to the highest one; losers are
 * recorded as "superseded".
 */
export function resolveCapabilitySnapshot(input: CapabilityResolutionInput): CapabilitySnapshot {
  const excluded: ExcludedCapability[] = [];
  const eligible = new Map<string, CapabilityManifest>();

  for (const manifest of input.manifests) {
    const reason = exclusionReasonFor(manifest, input);
    if (reason) {
      excluded.push({ name: manifest.name, version: manifest.version, reason });
      continue;
    }
    const current = eligible.get(manifest.name);
    if (!current) {
      eligible.set(manifest.name, manifest);
      continue;
    }
    const currentVersion = parseSemanticVersion(current.version);
    const nextVersion = parseSemanticVersion(manifest.version);
    if (!currentVersion || !nextVersion) {
      // Unreachable: invalid versions were excluded above. Guard for safety.
      continue;
    }
    if (compareSemanticVersions(nextVersion, currentVersion) > 0) {
      excluded.push({ name: current.name, version: current.version, reason: "superseded" });
      eligible.set(manifest.name, manifest);
    } else {
      excluded.push({ name: manifest.name, version: manifest.version, reason: "superseded" });
    }
  }

  const capabilities = [...eligible.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  return { capabilities, excluded };
}
