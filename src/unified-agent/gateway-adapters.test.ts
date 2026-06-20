// Tests for the phase 3/4/5 gateway adapters: runtime-event mapping, sandbox
// binding resolution, and the shadow runner — all isolated and fake-driven.
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../packages/loop-runtime/src/index.js";
import type { GatewayTurnReply, GatewayTurnRequest } from "./gateway-bridge.js";
import { createGatewayEventSink, mapRuntimeEvent, type GatewayUiEvent } from "./gateway-events.js";
import { resolveBinding } from "./gateway-resolve.js";
import { runShadowTurn } from "./gateway-shadow.js";

describe("mapRuntimeEvent (phase 3)", () => {
  it("maps a completed tool call", () => {
    const ev: RuntimeEvent = {
      kind: "tool_call_finished",
      sessionId: "s1",
      capability: "fs.write",
      isError: false,
      replayed: false,
      durationMs: 12.5,
    };
    expect(mapRuntimeEvent(ev)).toEqual({
      type: "tool.call.completed",
      sessionId: "s1",
      capability: "fs.write",
      durationMs: 12.5,
      replayed: false,
    });
  });

  it("maps a failed tool call", () => {
    const ev: RuntimeEvent = {
      kind: "tool_call_finished",
      sessionId: "s1",
      capability: "web.fetch",
      isError: true,
      replayed: false,
      durationMs: 30,
    };
    expect(mapRuntimeEvent(ev)?.type).toBe("tool.call.failed");
  });

  it("maps approvals and run status, ignores internal events", () => {
    expect(mapRuntimeEvent({ kind: "approval_resolved", sessionId: "s1", capability: "fs.write", riskClass: "write", decision: "user-allowed" })?.type).toBe("approval.resolved");
    expect(mapRuntimeEvent({ kind: "turn_finished", sessionId: "s1", status: "finished", toolCalls: 2, tokensUsed: 0 })?.type).toBe("run.completed");
    expect(mapRuntimeEvent({ kind: "turn_finished", sessionId: "s1", status: "awaiting-user", toolCalls: 0, tokensUsed: 0 })?.type).toBe("run.awaiting_user");
    expect(mapRuntimeEvent({ kind: "turn_finished", sessionId: "s1", status: "suspended", toolCalls: 0, tokensUsed: 0 })?.type).toBe("run.suspended");
    expect(mapRuntimeEvent({ kind: "turn_finished", sessionId: "s1", status: "budget-exhausted", toolCalls: 0, tokensUsed: 0 })?.type).toBe("run.budget_exhausted");
    expect(mapRuntimeEvent({ kind: "brain_action", sessionId: "s1", action: "tool_call" })).toBeNull();
    expect(mapRuntimeEvent({ kind: "inference_finished", sessionId: "s1", tier: "fast", tokensUsed: 9 })).toBeNull();
  });

  it("event sink forwards only mapped events", () => {
    const out: GatewayUiEvent[] = [];
    const sink = createGatewayEventSink((e) => out.push(e));
    sink({ kind: "turn_started", sessionId: "s1", brainId: "acp", brainVersion: "0.1.0", mode: "acp" });
    sink({ kind: "brain_action", sessionId: "s1", action: "respond" });
    sink({ kind: "turn_finished", sessionId: "s1", status: "finished", toolCalls: 1, tokensUsed: 0 });
    expect(out.map((e) => e.type)).toEqual(["run.started", "run.completed"]);
  });
});

describe("resolveBinding (phase 4)", () => {
  it("prefers a paired device, then repo, else general", () => {
    expect(resolveBinding({ deviceId: "d9" })).toEqual({ kind: "client-node", deviceId: "d9" });
    expect(resolveBinding({ repoRef: "org/repo#main" })).toEqual({ kind: "cloud-repo", repoRef: "org/repo#main" });
    expect(resolveBinding({ workspaceId: "w1" })).toEqual({ kind: "cloud-general", workspaceId: "w1" });
    expect(resolveBinding()).toEqual({ kind: "cloud-general" });
  });

  it("device wins over repo and workspace", () => {
    expect(resolveBinding({ deviceId: "d1", repoRef: "o/r", workspaceId: "w" })).toEqual({
      kind: "client-node",
      deviceId: "d1",
    });
  });
});

describe("runShadowTurn (phase 5)", () => {
  const req: GatewayTurnRequest = {
    agentId: "a1",
    sessionId: "s1",
    userMessage: "hi",
    model: { provider: "t", api: "openai-completions", modelId: "m", baseUrl: "x", apiKeyEnv: "K" },
  };
  const reply = (responses: string[], status: GatewayTurnReply["status"] = "finished"): GatewayTurnReply => ({
    status,
    responses,
  });

  it("returns no divergence when both engines agree", async () => {
    const out = await runShadowTurn(req, () => Promise.resolve(reply(["same"])), () => Promise.resolve(reply(["same"])));
    expect(out.diverged).toBe(false);
    expect(out.primary.responses).toEqual(["same"]);
  });

  it("flags divergence in status or responses", async () => {
    const out = await runShadowTurn(req, () => Promise.resolve(reply(["a"])), () => Promise.resolve(reply(["b"])));
    expect(out.diverged).toBe(true);
    expect(out.notes.join()).toMatch(/responses differ/);
  });

  it("never lets a shadow failure break the turn", async () => {
    const out = await runShadowTurn(
      req,
      () => Promise.resolve(reply(["primary ok"])),
      () => Promise.reject(new Error("shadow boom")),
    );
    expect(out.primary.responses).toEqual(["primary ok"]);
    expect(out.diverged).toBe(true);
    expect(out.notes.join()).toMatch(/shadow threw/);
  });
});
