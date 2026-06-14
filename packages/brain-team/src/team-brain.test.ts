// Team brain tests: a scripted inference port plays the orchestrator model
// while the REAL loop runtime runs the spawned subtasks through an injected
// runner. The brain decomposes, the runtime runs subtasks in parallel, the
// brain synthesizes — all over the same contract the other brains use.
import { describe, expect, it } from "vitest";
import type {
  InferencePort,
  InferenceRequest,
  InferenceResult,
} from "../../brain-contract/src/index.js";
import {
  LoopRuntime,
  type RuntimeEvent,
  type SubtaskRunner,
} from "../../loop-runtime/src/index.js";
import {
  CORE_CAPABILITY_MANIFESTS,
  MemorySandbox,
  SandboxRouter,
} from "../../sandbox-core/src/index.js";
import { createTeamBrain } from "./team-brain.js";

const TEAM_MODE = { id: "team", maxParallelToolCalls: 1, planningEnabled: false };

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

function buildHarness(responses: Partial<InferenceResult>[], spawnSubtask: SubtaskRunner) {
  const router = new SandboxRouter();
  router.register(new MemorySandbox());
  const model = scriptedModel(responses);
  const events: RuntimeEvent[] = [];
  const runtime = new LoopRuntime({
    brain: createTeamBrain({ systemPrompt: "You orchestrate." }),
    manifests: CORE_CAPABILITY_MANIFESTS,
    router,
    inference: model.port,
    approvalGate: { decide: () => Promise.resolve("allow") },
    policy: "auto",
    spawnSubtask,
    telemetry: (event) => events.push(event),
  });
  return { runtime, model, events };
}

function turnInput(userMessage: string) {
  return {
    sessionId: "s1",
    userMessage,
    binding: { kind: "cloud-general" as const },
    mode: TEAM_MODE,
  };
}

describe("team brain v1", () => {
  it("decomposes, delegates a parallel batch, then synthesizes results", async () => {
    const spawned: string[] = [];
    const runner: SubtaskRunner = (_sessionId, spec) => {
      spawned.push(spec.title);
      return Promise.resolve(`found data for ${spec.title}`);
    };
    const { runtime, model, events } = buildHarness(
      [
        { text: "1. Research topic A\n2. Research topic B" }, // decompose
        { text: "Here is the combined report." }, // synthesize
      ],
      runner,
    );

    const result = await runtime.runTurn(turnInput("write a report on A and B"));

    expect(result.status).toBe("finished");
    expect(result.summary).toBe("Here is the combined report.");

    // Both subtasks were delegated (order is parallel, so compare sorted).
    expect(spawned.toSorted()).toEqual(["Research topic A", "Research topic B"]);

    // Decompose call: no tools, decomposition prompt.
    expect(model.requests[0]!.tools).toBeUndefined();
    expect(model.requests[0]!.system).toContain("independent subtasks");

    // Synthesize call sees the subtask results in its conversation context.
    const synthMessages = model.requests[1]!.messages;
    expect(
      synthMessages.some((m) => m.kind === "system" && m.text.includes("found data for")),
    ).toBe(true);
    expect(model.requests[1]!.system).toContain("Synthesize");

    const actions = events.filter((e) => e.kind === "brain_action").map((e) => e.action);
    expect(actions).toEqual(["spawn", "respond", "finish"]);
  });

  it("falls back to a single subtask when decomposition yields nothing", async () => {
    const spawned: { title: string; instructions: string }[] = [];
    const runner: SubtaskRunner = (_sessionId, spec) => {
      spawned.push({ title: spec.title, instructions: spec.instructions });
      return Promise.resolve("handled");
    };
    const { runtime } = buildHarness([{ text: "" }, { text: "Done." }], runner);

    const result = await runtime.runTurn(turnInput("just handle this request"));

    expect(result.status).toBe("finished");
    expect(spawned).toHaveLength(1);
    // The single subtask carries the original user request.
    expect(spawned[0]!.instructions).toBe("just handle this request");
  });
});
