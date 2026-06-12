// Minimal semantic-version helpers for capability contract negotiation.
// Deliberately dependency-free: the contract package must stay importable
// from brains, providers, and clients alike.

/** Parsed semantic version. Build metadata is ignored on purpose. */
export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses a semver string; returns null when the input is not valid semver. */
export function parseSemanticVersion(value: string): SemanticVersion | null {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { prerelease: match[4] } : {}),
  };
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) {
    return 0;
  }
  // A version without a prerelease tag is higher than one with it.
  if (a === undefined) {
    return 1;
  }
  if (b === undefined) {
    return -1;
  }
  return a < b ? -1 : 1;
}

/** Compares two parsed versions; negative when `a` is lower than `b`. */
export function compareSemanticVersions(a: SemanticVersion, b: SemanticVersion): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  if (a.patch !== b.patch) {
    return a.patch - b.patch;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Returns true when an offered capability version can serve a consumer built
 * against `required`: same major, offered at least as high as required.
 * Major 0 versions are treated as unstable and must match exactly on minor.
 */
export function isCompatibleVersion(offered: string, required: string): boolean {
  const offer = parseSemanticVersion(offered);
  const need = parseSemanticVersion(required);
  if (!offer || !need) {
    return false;
  }
  if (offer.major !== need.major) {
    return false;
  }
  if (offer.major === 0 && offer.minor !== need.minor) {
    return false;
  }
  return compareSemanticVersions(offer, need) >= 0;
}

/**
 * Picks the highest offered version compatible with `required`.
 * Returns null when nothing is compatible.
 */
export function pickHighestCompatible(offered: string[], required: string): string | null {
  let best: { raw: string; parsed: SemanticVersion } | null = null;
  for (const raw of offered) {
    if (!isCompatibleVersion(raw, required)) {
      continue;
    }
    const parsed = parseSemanticVersion(raw);
    if (!parsed) {
      continue;
    }
    if (!best || compareSemanticVersions(parsed, best.parsed) > 0) {
      best = { raw, parsed };
    }
  }
  return best?.raw ?? null;
}
