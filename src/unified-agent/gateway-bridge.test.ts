// Gateway bridge tests: runUnifiedAgentTurn maps a gateway request to a
// TurnInput, drives the agent, and maps the TurnResult back — verified with a
// fake agent so no LLM or store is touched.
import { describe, expect, it } from "vitest";
import type { TurnInput, TurnResult } from "../../packages/loop-runtime/src/index.js";
import {
  runUnifiedAgentTurn,
  type GatewayTurnRequest,
  type UnifiedAgentLike,
} from "./gateway-bridge.js";

const MODEL: GatewayTurnRequest["model"] = {
  provider: "test",
  api: "openai-completions",
  modelId: "test-model",
  baseUrl: "http://localhost",
  apiKeyEnv: "TEST_KEY",
};

function baseReq(overrides: Partial<GatewayTurnRequest> = {}): GatewayTurnRequest {
  return {
    agentId: "a1",
    sessionId: "s1",
    userMessage: "hello",
    model: MODEL,
    ...overrides,
  };
}

/** A fake agent that records the TurnInput and returns a scripted result. */
function fakeAgent(result: TurnResult) {
  const inputs: TurnInput[] = [];
  let closed = 0;
  const agent: UnifiedAgentLike = {
    runtime: {
      runTurn: (input) => {
        inputs.push(input);
        return Promise.resolve(result);
      },
    },
    close: () => {
      closed += 1;
    },
  };
  return { agent, inputs, get closed() {
    return closed;
  } };
}

describe("runUnifiedAgentTurn", () => {
  it("maps a finished result to a reply", async () => {
    const fake = fakeAgent({ status: "finished", responses: ["hi there"], summary: "hi there" });
    const reply = await runUnifiedAgentTurn(baseReq(), { agent: fake.agent });
    expect(reply).toEqual({ status: "finished", responses: ["hi there"], summary: "hi there" });
  });

  it("builds the TurnInput from the request, defaulting the binding", async () => {
    const fake = fakeAgent({ status: "finished", responses: [] });
    await runUnifiedAgentTurn(baseReq({ userMessage: "do it" }), { agent: fake.agent });
    expect(fake.inputs[0]).toMatchObject({
      sessionId: "s1",
      userMessage: "do it",
      binding: { kind: "cloud-general" },
      mode: { id: "standard", maxParallelToolCalls: 1, planningEnabled: false },
    });
  });

  it("translates mode into the loop ModeConfig", async () => {
    const deep = fakeAgent({ status: "finished", responses: [] });
    await runUnifiedAgentTurn(baseReq({ mode: "deep" }), { agent: deep.agent });
    expect(deep.inputs[0]?.mode).toEqual({ id: "deep", maxParallelToolCalls: 1, planningEnabled: true });

    const team = fakeAgent({ status: "finished", responses: [] });
    await runUnifiedAgentTurn(baseReq({ mode: "team" }), { agent: team.agent });
    expect(team.inputs[0]?.mode).toEqual({ id: "team", maxParallelToolCalls: 4, planningEnabled: false });
  });

  it("passes through an explicit binding and budget", async () => {
    const fake = fakeAgent({ status: "finished", responses: [] });
    await runUnifiedAgentTurn(
      baseReq({ binding: { kind: "client-node", deviceId: "d9" }, budget: { toolCalls: 3 } }),
      { agent: fake.agent },
    );
    expect(fake.inputs[0]?.binding).toEqual({ kind: "client-node", deviceId: "d9" });
    expect(fake.inputs[0]?.budget).toEqual({ toolCalls: 3 });
  });

  it("maps an awaiting-user result to a question", async () => {
    const fake = fakeAgent({ status: "awaiting-user", responses: [], question: "which file?" });
    const reply = await runUnifiedAgentTurn(baseReq(), { agent: fake.agent });
    expect(reply.status).toBe("awaiting-user");
    expect(reply.question).toBe("which file?");
  });

  it("does not close a caller-provided agent", async () => {
    const fake = fakeAgent({ status: "finished", responses: [] });
    await runUnifiedAgentTurn(baseReq(), { agent: fake.agent });
    expect(fake.closed).toBe(0);
  });

  it("builds and closes an owned agent from the factory", async () => {
    const fake = fakeAgent({ status: "finished", responses: ["built"] });
    const reply = await runUnifiedAgentTurn(baseReq(), { buildAgent: () => fake.agent });
    expect(reply.responses).toEqual(["built"]);
    expect(fake.closed).toBe(1);
  });
});
