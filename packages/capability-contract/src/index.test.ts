// Capability contract tests cover manifest validation, version negotiation,
// risk decisions, and snapshot resolution.
import { describe, expect, it } from "vitest";
import {
  isCompatibleVersion,
  matchesCapabilityPattern,
  maxRiskClass,
  pickHighestCompatible,
  resolveCapabilitySnapshot,
  resolveRiskDecision,
  validateCapabilityManifest,
  type CapabilityManifest,
} from "./index.js";

function manifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    name: "fs.read",
    version: "1.0.0",
    description: "Read a file from the workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    riskClass: "read",
    sandboxRequires: ["fs"],
    providerKinds: ["cloud-general", "client-node"],
    ...overrides,
  };
}

describe("validateCapabilityManifest", () => {
  it("accepts a well-formed manifest", () => {
    const result = validateCapabilityManifest(manifest());
    expect(result.ok).toBe(true);
  });

  it("collects every problem instead of failing fast", () => {
    const result = validateCapabilityManifest({
      name: "BadName",
      version: "not-semver",
      description: "",
      inputSchema: { type: "array" },
      riskClass: "scary",
      sandboxRequires: ["gpu"],
      providerKinds: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(7);
    }
  });

  it("rejects single-segment capability names", () => {
    const result = validateCapabilityManifest(manifest({ name: "read" }));
    expect(result.ok).toBe(false);
  });
});

describe("version negotiation", () => {
  it("treats same-major higher versions as compatible", () => {
    expect(isCompatibleVersion("1.4.0", "1.2.0")).toBe(true);
    expect(isCompatibleVersion("2.0.0", "1.2.0")).toBe(false);
    expect(isCompatibleVersion("1.1.0", "1.2.0")).toBe(false);
  });

  it("pins unstable 0.x versions to the same minor", () => {
    expect(isCompatibleVersion("0.3.5", "0.3.1")).toBe(true);
    expect(isCompatibleVersion("0.4.0", "0.3.1")).toBe(false);
  });

  it("picks the highest compatible offer", () => {
    expect(pickHighestCompatible(["1.0.0", "1.3.2", "2.0.0", "1.3.10"], "1.1.0")).toBe("1.3.10");
    expect(pickHighestCompatible(["2.0.0"], "1.1.0")).toBeNull();
  });

  it("ranks release versions above their prereleases", () => {
    expect(pickHighestCompatible(["1.2.0-beta.1", "1.2.0"], "1.0.0")).toBe("1.2.0");
  });
});

describe("risk decisions", () => {
  it("denies everything but reads under read-only policy", () => {
    expect(resolveRiskDecision("read", "read-only")).toBe("allow");
    expect(resolveRiskDecision("write", "read-only")).toBe("deny");
    expect(resolveRiskDecision("destructive", "read-only")).toBe("deny");
  });

  it("asks for mutating classes under ask policy", () => {
    expect(resolveRiskDecision("read", "ask")).toBe("allow");
    expect(resolveRiskDecision("write", "ask")).toBe("ask");
    expect(resolveRiskDecision("execute", "ask")).toBe("ask");
  });

  it("still asks for destructive actions under auto policy", () => {
    expect(resolveRiskDecision("execute", "auto")).toBe("allow");
    expect(resolveRiskDecision("destructive", "auto")).toBe("ask");
  });

  it("computes the most dangerous class", () => {
    expect(maxRiskClass("read", "execute", "write")).toBe("execute");
  });
});

describe("capability patterns", () => {
  it("matches exact names and family wildcards", () => {
    expect(matchesCapabilityPattern("fs.read", "fs.read")).toBe(true);
    expect(matchesCapabilityPattern("fs.read", "fs.*")).toBe(true);
    expect(matchesCapabilityPattern("exec.run", "fs.*")).toBe(false);
  });
});

describe("resolveCapabilitySnapshot", () => {
  const sandbox = { kind: "client-node", primitives: ["fs", "proc"] } as const;

  it("keeps capabilities the sandbox supports and records exclusions", () => {
    const snapshot = resolveCapabilitySnapshot({
      manifests: [
        manifest(),
        manifest({
          name: "web.search",
          sandboxRequires: ["net"],
          providerKinds: ["cloud-general"],
        }),
        manifest({ name: "fs.write", riskClass: "write", sandboxRequires: ["fs", "net"] }),
      ],
      sandbox: { ...sandbox, primitives: [...sandbox.primitives] },
    });
    expect(snapshot.capabilities.map((c) => c.name)).toEqual(["fs.read"]);
    expect(snapshot.excluded).toEqual([
      { name: "web.search", version: "1.0.0", reason: "provider-mismatch" },
      { name: "fs.write", version: "1.0.0", reason: "missing-primitive" },
    ]);
  });

  it("collapses duplicate names to the highest version", () => {
    const snapshot = resolveCapabilitySnapshot({
      manifests: [manifest({ version: "1.2.0" }), manifest({ version: "1.10.0" })],
      sandbox: { ...sandbox, primitives: [...sandbox.primitives] },
    });
    expect(snapshot.capabilities).toHaveLength(1);
    expect(snapshot.capabilities[0]?.version).toBe("1.10.0");
    expect(snapshot.excluded).toEqual([
      { name: "fs.read", version: "1.2.0", reason: "superseded" },
    ]);
  });

  it("drops deprecated capabilities unless explicitly included", () => {
    const manifests = [manifest({ deprecated: true })];
    const dropped = resolveCapabilitySnapshot({
      manifests,
      sandbox: { ...sandbox, primitives: [...sandbox.primitives] },
    });
    expect(dropped.capabilities).toHaveLength(0);
    expect(dropped.excluded[0]?.reason).toBe("deprecated");

    const kept = resolveCapabilitySnapshot({
      manifests,
      sandbox: { ...sandbox, primitives: [...sandbox.primitives] },
      includeDeprecated: true,
    });
    expect(kept.capabilities).toHaveLength(1);
  });

  it("applies allow and deny entitlement patterns", () => {
    const snapshot = resolveCapabilitySnapshot({
      manifests: [
        manifest(),
        manifest({ name: "fs.delete", riskClass: "destructive" }),
        manifest({ name: "exec.run", riskClass: "execute", sandboxRequires: ["proc"] }),
      ],
      sandbox: { ...sandbox, primitives: [...sandbox.primitives] },
      entitlements: { allowPatterns: ["fs.*"], denyPatterns: ["fs.delete"] },
    });
    expect(snapshot.capabilities.map((c) => c.name)).toEqual(["fs.read"]);
    expect(snapshot.excluded).toEqual([
      { name: "fs.delete", version: "1.0.0", reason: "denied" },
      { name: "exec.run", version: "1.0.0", reason: "not-allowed" },
    ]);
  });
});
