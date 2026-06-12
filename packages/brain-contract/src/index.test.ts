// Brain contract tests cover action validation and brain requirement checks.
import { describe, expect, it } from "vitest";
import type { CapabilityManifest } from "../../capability-contract/src/index.js";
import { unmetBrainRequirements, validateBrainAction, type BrainDescriptor } from "./index.js";

function capability(name: string): CapabilityManifest {
  return {
    name,
    version: "1.0.0",
    description: `${name} capability`,
    inputSchema: { type: "object" },
    riskClass: "read",
    sandboxRequires: [],
    providerKinds: ["cloud-general"],
  };
}

const baseCtx = {
  capabilities: [capability("fs.read"), capability("exec.run")],
  usedIdempotencyKeys: new Set<string>(),
};

describe("validateBrainAction", () => {
  it("accepts a tool call for a capability in the snapshot", () => {
    expect(
      validateBrainAction(
        { kind: "tool_call", capability: "fs.read", args: { path: "a.txt" }, idempotencyKey: "k1" },
        baseCtx,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects tool calls for capabilities outside the snapshot", () => {
    const result = validateBrainAction(
      { kind: "tool_call", capability: "web.search", args: {}, idempotencyKey: "k1" },
      baseCtx,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects reused idempotency keys", () => {
    const result = validateBrainAction(
      { kind: "tool_call", capability: "fs.read", args: {}, idempotencyKey: "k1" },
      { ...baseCtx, usedIdempotencyKeys: new Set(["k1"]) },
    );
    expect(result.ok).toBe(false);
  });

  it("requires plan revisions to increment by exactly one", () => {
    const plan = { revision: 2, steps: [{ id: "s1", title: "step", status: "pending" as const }] };
    expect(
      validateBrainAction(
        { kind: "plan", plan: { revision: 3, steps: plan.steps } },
        { ...baseCtx, plan },
      ).ok,
    ).toBe(true);
    expect(
      validateBrainAction(
        { kind: "plan", plan: { revision: 5, steps: plan.steps } },
        { ...baseCtx, plan },
      ).ok,
    ).toBe(false);
  });

  it("rejects empty responses, summaries, and questions", () => {
    expect(validateBrainAction({ kind: "respond", text: "" }, baseCtx).ok).toBe(false);
    expect(validateBrainAction({ kind: "finish", summary: "" }, baseCtx).ok).toBe(false);
    expect(
      validateBrainAction({ kind: "ask_user", elicitation: { question: "" } }, baseCtx).ok,
    ).toBe(false);
  });
});

describe("unmetBrainRequirements", () => {
  const descriptor: BrainDescriptor = {
    id: "standard",
    version: "1.0.0",
    capabilitiesRequired: ["fs.*", "exec.run"],
  };

  it("returns empty when the snapshot satisfies every requirement", () => {
    expect(unmetBrainRequirements(descriptor, baseCtx.capabilities)).toEqual([]);
  });

  it("lists patterns the snapshot cannot satisfy", () => {
    expect(unmetBrainRequirements(descriptor, [capability("fs.read")])).toEqual(["exec.run"]);
  });
});
