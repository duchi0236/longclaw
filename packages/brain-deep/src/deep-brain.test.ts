// Deep brain tests: a scripted inference port plays the model while the REAL
// loop runtime and in-memory sandbox execute the decisions — the same runtime,
// capability manifests, and sandbox the standard brain uses. Swapping in the
// deep brain changes the decision pattern (plan first, then execute) without
// touching anything on the tool side.
import { describe, expect, it } from "vitest";
import type {
  InferencePort,
  InferenceRequest,
  InferenceResult,
} from "../../brain-contract/src/index.js";
import { LoopRuntime, type RuntimeEvent } from "../../loop-runtime/src/index.js";
import {
  CORE_CAPABILITY_MANIFESTS,
  MemorySandbox,
  SandboxRouter,
} from "../../sandbox-core/src/index.js";
import { createDeepBrain } from "./deep-brain.js";

const DEEP_MODE = { id: "deep", maxParallelToolCalls: 1, planningEnabled: true };

function scriptedModel(responses: Partial<InferenceResult>[]) {
  const requests: InferenceRequest[] = [];
  let index = 0;
  const port: InferencePort = (request) => {
    requests.push(request);
    const response = responses[index] ?? { text: "done" };
    index += 1;
    return Promise.resolve({ text: "", tokensUsed: 5, ...response });
  };
  return { port, requests };
}

function buildHarness(responses: Partial<InferenceResult>[]) {
  const sandbox = new MemorySandbox({ execScript: (cmd) => ({ output: `ok:${cmd}` }) });
  const router = new SandboxRouter();
  router.register(sandbox);
  const model = scriptedModel(responses);
  const events: RuntimeEvent[] = [];
  const runtime = new LoopRuntime({
    brain: createDeepBrain({ systemPrompt: "You are a worker." }),
    manifests: CORE_CAPABILITY_MANIFESTS,
    router,
    inference: model.port,
    approvalGate: { decide: () => Promise.resolve("allow") },
    policy: "auto",
    telemetry: (event) => events.push(event),
  });
  return { runtime, sandbox, model, events };
}

function turnInput(userMessage: string) {
  return {
    sessionId: "s1",
    userMessage,
    binding: { kind: "cloud-general" as const },
    mode: DEEP_MODE,
  };
}

describe("deep brain v1", () => {
  it("plans first, then executes against the plan on the shared tool stack", async () => {
    const { runtime, sandbox, model, events } = buildHarness([
      // 1) planning turn: a numbered list, no tool calls
      { text: "1. Write the greeting file\n2. Confirm the contents" },
      // 2) execution turn: a tool call
      { toolCalls: [{ id: "a", name: "fs.write", args: { path: "hi.txt", content: "hello" } }] },
      // 3) execution turn: final summary, no tool call
      { text: "All steps complete." },
    ]);

    const result = await runtime.runTurn(turnInput("create a greeting file"));

    expect(result.status).toBe("finished");
    expect(result.summary).toBe("All steps complete.");
    // Same sandbox the standard brain uses — the tool actually ran.
    expect(sandbox.files.get("hi.txt")).toBe("hello");

    // The first model call is planning: no tools offered, a planning system prompt.
    expect(model.requests[0]!.tools).toBeUndefined();
    expect(model.requests[0]!.system).toContain("break the task");

    // The second call is execution: the plan is in the prompt and tools are offered.
    expect(model.requests[1]!.system).toContain("Write the greeting file");
    expect(model.requests[1]!.tools?.map((t) => t.name)).toContain("fs.write");
    expect(model.requests).toHaveLength(3);

    // The decision pattern is plan → tool_call → respond → finish.
    const actions = events.filter((e) => e.kind === "brain_action").map((e) => e.action);
    expect(actions).toEqual(["plan", "tool_call", "respond", "finish"]);
  });

  it("falls back to a one-step plan when the model returns no parseable steps", async () => {
    const { runtime, events } = buildHarness([
      { text: "" }, // planning produced nothing usable
      { text: "Handled it." }, // execution finishes immediately
    ]);

    const result = await runtime.runTurn(turnInput("just do it"));

    expect(result.status).toBe("finished");
    // A plan action was still emitted, so execution had a plan to run against.
    const actions = events.filter((e) => e.kind === "brain_action").map((e) => e.action);
    expect(actions[0]).toBe("plan");
  });

  it("ends the turn when execution yields a plain answer", async () => {
    const { runtime, model } = buildHarness([
      { text: "1. Answer the question" },
      { text: "The answer is 42." },
    ]);

    const result = await runtime.runTurn(turnInput("what is the answer"));

    expect(result.status).toBe("finished");
    expect(result.summary).toBe("The answer is 42.");
    expect(model.requests).toHaveLength(2);
  });
});
