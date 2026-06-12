// Standard brain v1 tests: a scripted inference port plays the model while
// the real loop runtime and in-memory sandbox execute the decisions. The
// assertions pin the agent-loop semantics this brain must preserve: one
// assistant message per inference, batched tool calls, turn ends on the
// first assistant message without tool calls.
import { describe, expect, it } from "vitest";
import type {
  InferencePort,
  InferenceRequest,
  InferenceResult,
} from "../../brain-contract/src/index.js";
import { LoopRuntime } from "../../loop-runtime/src/index.js";
import {
  CORE_CAPABILITY_MANIFESTS,
  MemorySandbox,
  SandboxRouter,
} from "../../sandbox-core/src/index.js";
import { capabilityToToolDefinition, createStandardBrain } from "./standard-brain.js";

const STANDARD_MODE = { id: "standard", maxParallelToolCalls: 1, planningEnabled: false };

/** Inference port that replays scripted model responses and records requests. */
function scriptedModel(responses: Partial<InferenceResult>[]) {
  const requests: InferenceRequest[] = [];
  let index = 0;
  const port: InferencePort = (request) => {
    requests.push(request);
    const response = responses[index] ?? { text: "script exhausted" };
    index += 1;
    return Promise.resolve({ text: "", tokensUsed: 10, ...response });
  };
  return { port, requests };
}

function buildHarness(responses: Partial<InferenceResult>[], options = {}) {
  const sandbox = new MemorySandbox({ execScript: (cmd) => ({ output: `ok:${cmd}` }) });
  const router = new SandboxRouter();
  router.register(sandbox);
  const model = scriptedModel(responses);
  const runtime = new LoopRuntime({
    brain: createStandardBrain(options),
    manifests: CORE_CAPABILITY_MANIFESTS,
    router,
    inference: model.port,
    approvalGate: { decide: () => Promise.resolve("allow") },
    policy: "auto",
  });
  return { runtime, sandbox, model };
}

function turnInput(userMessage: string) {
  return {
    sessionId: "session-1",
    userMessage,
    binding: { kind: "cloud-general" as const },
    mode: STANDARD_MODE,
  };
}

describe("standard brain v1", () => {
  it("answers a plain question with one inference and finishes", async () => {
    const { runtime, model } = buildHarness([{ text: "Paris." }]);

    const result = await runtime.runTurn(turnInput("Capital of France?"));

    expect(result.status).toBe("finished");
    expect(result.responses).toEqual(["Paris."]);
    expect(result.summary).toBe("Paris.");
    expect(model.requests).toHaveLength(1);

    const request = model.requests[0]!;
    expect(request.messages.at(-1)).toEqual({ kind: "user", text: "Capital of France?" });
    expect(request.tools?.map((t) => t.name)).toEqual([
      "exec.run",
      "fs.list",
      "fs.read",
      "fs.write",
    ]);
  });

  it("runs the classic loop: tool batch, re-inference with results, final answer", async () => {
    const { runtime, sandbox, model } = buildHarness([
      {
        text: "Writing the fix and running tests.",
        toolCalls: [
          {
            id: "a",
            name: "fs.write",
            args: { path: "src/fix.ts", content: "export const ok = 1;" },
          },
          { id: "b", name: "exec.run", args: { command: "npm test" } },
        ],
      },
      { text: "All tests pass." },
    ]);

    const result = await runtime.runTurn(turnInput("fix the bug"));

    expect(result.status).toBe("finished");
    expect(result.responses).toEqual(["Writing the fix and running tests.", "All tests pass."]);
    expect(result.summary).toBe("All tests pass.");
    expect(sandbox.files.get("src/fix.ts")).toBe("export const ok = 1;");
    expect(sandbox.invocations.map((i) => i.capability)).toEqual(["fs.write", "exec.run"]);

    // The second inference must see both tool results, mirroring how the
    // existing loop feeds the whole executed batch back to the model.
    expect(model.requests).toHaveLength(2);
    const secondMessages = model.requests[1]!.messages;
    const toolResults = secondMessages.filter((e) => e.kind === "tool_result");
    expect(toolResults).toHaveLength(2);
    expect(toolResults[1]).toMatchObject({ capability: "exec.run", output: "ok:npm test" });
  });

  it("derives session-unique idempotency keys even when the model reuses call ids", async () => {
    const reusedId = [{ id: "call_0", name: "fs.list", args: {} }];
    const { runtime, sandbox } = buildHarness([
      { toolCalls: reusedId },
      { text: "first done" },
      { toolCalls: reusedId },
      { text: "second done" },
    ]);

    await runtime.runTurn(turnInput("list once"));
    const second = await runtime.runTurn(turnInput("list again"));

    expect(second.status).toBe("finished");
    const keys = sandbox.invocations.map((i) => i.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(sandbox.invocations.every((i) => !i.replayed)).toBe(true);
  });

  it("recovers when the model hallucinates an unknown tool", async () => {
    const { runtime, model } = buildHarness([
      { toolCalls: [{ id: "x", name: "web.search", args: { q: "?" } }] },
      { text: "Answering from what I know instead." },
    ]);

    const result = await runtime.runTurn(turnInput("look this up"));

    expect(result.status).toBe("finished");
    expect(result.responses).toEqual(["Answering from what I know instead."]);
    // The rejection came back as conversation context for the retry call.
    const retryMessages = model.requests[1]!.messages;
    expect(retryMessages.some((e) => e.kind === "system" && e.text.includes("web.search"))).toBe(
      true,
    );
  });

  it("passes system prompt and tier through to the model", async () => {
    const { runtime, model } = buildHarness([{ text: "ok" }], {
      systemPrompt: "You are OpenClaw.",
      tier: "strong",
    });

    await runtime.runTurn(turnInput("hi"));

    expect(model.requests[0]).toMatchObject({ tier: "strong", system: "You are OpenClaw." });
  });

  it("finishes instead of spinning when the model returns nothing", async () => {
    const { runtime, model } = buildHarness([{ text: "" }]);

    const result = await runtime.runTurn(turnInput("hello?"));

    expect(result.status).toBe("finished");
    expect(model.requests).toHaveLength(1);
  });
});

describe("capabilityToToolDefinition", () => {
  it("exposes name, description, and input schema to the model", () => {
    const manifest = CORE_CAPABILITY_MANIFESTS[0]!;
    expect(capabilityToToolDefinition(manifest)).toEqual({
      name: manifest.name,
      description: manifest.description,
      inputSchema: manifest.inputSchema,
    });
  });
});
