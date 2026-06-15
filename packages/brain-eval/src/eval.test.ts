// Brain eval tests: scoring real brains over shared scenarios (standard vs
// deep) and the regression detection that gates a rollout.
import { describe, expect, it } from "vitest";
import type { InferencePort } from "../../brain-contract/src/index.js";
import { createDeepBrain } from "../../brain-deep/src/index.js";
import { createStandardBrain } from "../../brain-standard/src/index.js";
import {
  compareScorecards,
  evaluateBrain,
  type BrainScorecard,
  type EvalScenario,
  type ScenarioResult,
} from "./eval.js";

const DEEP_MODE = { id: "deep", maxParallelToolCalls: 1, planningEnabled: true };

// Content-routed so the same scenario runs both brains: deep's planning prompt
// gets a plan, everything else gets the scenario's real behavior.
function qaInference(answer: string): InferencePort {
  return (request) => {
    if (request.system?.includes("break the task")) {
      return Promise.resolve({ text: "1. Answer the question", tokensUsed: 4 });
    }
    return Promise.resolve({ text: answer, tokensUsed: 10 });
  };
}

function toolInference(): InferencePort {
  return (request) => {
    if (request.system?.includes("break the task")) {
      return Promise.resolve({ text: "1. Write the file", tokensUsed: 4 });
    }
    const hasResult = request.messages.some((message) => message.kind === "tool_result");
    if (hasResult) {
      return Promise.resolve({ text: "Done.", tokensUsed: 6 });
    }
    return Promise.resolve({
      text: "",
      toolCalls: [{ id: "a", name: "fs.write", args: { path: "x.txt", content: "hi" } }],
      tokensUsed: 8,
    });
  };
}

const scenarios: EvalScenario[] = [
  { name: "qa", userMessage: "what is the answer", inference: qaInference("42") },
  { name: "tool", userMessage: "write a file", inference: toolInference() },
];

const deepScenarios: EvalScenario[] = scenarios.map((scenario) => ({
  ...scenario,
  mode: DEEP_MODE,
}));

describe("evaluateBrain", () => {
  it("scores a brain and passes well-behaved scenarios", async () => {
    const card = await evaluateBrain(createStandardBrain(), scenarios);
    expect(card.brain).toBe("standard@1.0.0");
    expect(card.passRate).toBe(1);
    expect(card.results.map((result) => result.name)).toEqual(["qa", "tool"]);
    // The tool scenario actually invoked a tool.
    expect(card.results.find((result) => result.name === "tool")?.toolCalls).toBe(1);
  });

  it("shows the deep brain's planning overhead as extra steps", async () => {
    const standard = await evaluateBrain(createStandardBrain(), scenarios);
    const deep = await evaluateBrain(createDeepBrain(), deepScenarios);

    expect(standard.passRate).toBe(1);
    expect(deep.passRate).toBe(1);
    // Deep plans before executing, so it takes more decisions per scenario.
    expect(deep.avgSteps).toBeGreaterThan(standard.avgSteps);
  });
});

describe("compareScorecards", () => {
  function result(name: string, passed: boolean): ScenarioResult {
    return {
      name,
      status: passed ? "finished" : "error",
      steps: 2,
      toolCalls: 0,
      tokensUsed: 10,
      passed,
    };
  }
  function card(brain: string, results: ScenarioResult[]): BrainScorecard {
    const passed = results.filter((r) => r.passed).length;
    return {
      brain,
      results,
      passRate: passed / results.length,
      avgSteps: 2,
      avgToolCalls: 0,
      avgTokens: 10,
    };
  }

  it("flags scenarios the candidate regressed on", () => {
    const baseline = card("standard@1.0.0", [result("a", true), result("b", true)]);
    const candidate = card("standard@2.0.0", [result("a", true), result("b", false)]);

    const comparison = compareScorecards(baseline, candidate);
    expect(comparison.regressions).toEqual(["b"]);
    expect(comparison.passRateDelta).toBeCloseTo(-0.5);
  });

  it("reports no regressions when the candidate holds or improves", () => {
    const baseline = card("standard@1.0.0", [result("a", true), result("b", false)]);
    const candidate = card("standard@2.0.0", [result("a", true), result("b", true)]);

    const comparison = compareScorecards(baseline, candidate);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.passRateDelta).toBeCloseTo(0.5);
  });
});
