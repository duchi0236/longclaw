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
  it("accepts a batch of calls for capabilities in the snapshot", () => {
    expect(
      validateBrainAction(
        {
          kind: "tool_call",
          calls: [
            { capability: "fs.read", args: { path: "a.txt" }, idempotencyKey: "k1" },
            { capability: "exec.run", args: { command: "ls" }, idempotencyKey: "k2" },
          ],
        },
        baseCtx,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects empty batches", () => {
    expect(validateBrainAction({ kind: "tool_call", calls: [] }, baseCtx).ok).toBe(false);
  });

  it("rejects calls for capabilities outside the snapshot", () => {
    const result = validateBrainAction(
      { kind: "tool_call", calls: [{ capability: "web.search", args: {}, idempotencyKey: "k1" }] },
      baseCtx,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects idempotency keys reused across the session or within a batch", () => {
    const reusedAcrossSession = validateBrainAction(
      { kind: "tool_call", calls: [{ capability: "fs.read", args: {}, idempotencyKey: "k1" }] },
      { ...baseCtx, usedIdempotencyKeys: new Set(["k1"]) },
    );
    expect(reusedAcrossSession.ok).toBe(false);

    const reusedWithinBatch = validateBrainAction(
      {
        kind: "tool_call",
        calls: [
          { capability: "fs.read", args: {}, idempotencyKey: "k2" },
          { capability: "exec.run", args: {}, idempotencyKey: "k2" },
        ],
      },
      baseCtx,
    );
    expect(reusedWithinBatch.ok).toBe(false);
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
