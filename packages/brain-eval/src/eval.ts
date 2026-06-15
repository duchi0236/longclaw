// Brain evaluation: scores a brain against a set of scenarios and compares
// two brains. This is the brain side of the evolution loop, symmetric to tool
// purification — telemetry from real runs drives tool deprecation, scenario
// scores drive brain rollout. Because a brain is stateless and its only IO is
// the injected inference port, the same scenarios run any brain on the same
// runtime, capabilities, and sandbox; only the decisions differ.

import type { AgentBrain, InferencePort, ModeConfig } from "../../brain-contract/src/index.js";
import { LoopRuntime, type RuntimeEvent, type TurnResult } from "../../loop-runtime/src/index.js";
import {
  CORE_CAPABILITY_MANIFESTS,
  MemorySandbox,
  SandboxRouter,
  type SandboxProvider,
} from "../../sandbox-core/src/index.js";

const STANDARD_MODE: ModeConfig = {
  id: "standard",
  maxParallelToolCalls: 1,
  planningEnabled: false,
};

/** One evaluation case: a prompt, the model behavior to run it against, and an
 * optional pass criterion. The inference is supplied so eval is deterministic;
 * pass a real port for a live A/B instead. */
export interface EvalScenario {
  name: string;
  userMessage: string;
  inference: InferencePort;
  mode?: ModeConfig;
  /** Sandbox to run against; defaults to a fresh in-memory sandbox. */
  sandbox?: () => SandboxProvider;
  /** Pass criterion; defaults to "the turn finished". */
  check?: (result: TurnResult) => boolean;
}

/** Per-scenario outcome with the cost metrics that distinguish brains. */
export interface ScenarioResult {
  name: string;
  status: TurnResult["status"];
  steps: number;
  toolCalls: number;
  tokensUsed: number;
  passed: boolean;
}

/** Aggregate score for one brain across all scenarios. */
export interface BrainScorecard {
  brain: string;
  results: ScenarioResult[];
  passRate: number;
  avgSteps: number;
  avgToolCalls: number;
  avgTokens: number;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function runScenario(brain: AgentBrain, scenario: EvalScenario): Promise<ScenarioResult> {
  const router = new SandboxRouter();
  router.register(scenario.sandbox ? scenario.sandbox() : new MemorySandbox());
  const events: RuntimeEvent[] = [];
  const runtime = new LoopRuntime({
    brain,
    manifests: CORE_CAPABILITY_MANIFESTS,
    router,
    inference: scenario.inference,
    approvalGate: { decide: () => Promise.resolve("allow") },
    policy: "auto",
    telemetry: (event) => events.push(event),
  });

  const result = await runtime.runTurn({
    sessionId: scenario.name,
    userMessage: scenario.userMessage,
    binding: { kind: "cloud-general" },
    mode: scenario.mode ?? STANDARD_MODE,
  });

  const finished = events.find((event) => event.kind === "turn_finished");
  return {
    name: scenario.name,
    status: result.status,
    steps: events.filter((event) => event.kind === "brain_action").length,
    toolCalls: finished?.kind === "turn_finished" ? finished.toolCalls : 0,
    tokensUsed: finished?.kind === "turn_finished" ? finished.tokensUsed : 0,
    passed: scenario.check ? scenario.check(result) : result.status === "finished",
  };
}

/** Scores a brain across the scenarios, running each on its own runtime. */
export async function evaluateBrain(
  brain: AgentBrain,
  scenarios: EvalScenario[],
): Promise<BrainScorecard> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(brain, scenario));
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    brain: `${brain.descriptor.id}@${brain.descriptor.version}`,
    results,
    passRate: results.length === 0 ? 0 : passed / results.length,
    avgSteps: average(results.map((result) => result.steps)),
    avgToolCalls: average(results.map((result) => result.toolCalls)),
    avgTokens: average(results.map((result) => result.tokensUsed)),
  };
}

/** Difference between a candidate brain and the baseline it would replace. */
export interface BrainComparison {
  baseline: string;
  candidate: string;
  passRateDelta: number;
  avgStepsDelta: number;
  avgTokensDelta: number;
  /** Scenarios the baseline passed but the candidate failed — the rollout
   * red line: a positive count means the candidate regressed something. */
  regressions: string[];
}

/** Compares two scorecards over the same scenario set (matched by name). */
export function compareScorecards(
  baseline: BrainScorecard,
  candidate: BrainScorecard,
): BrainComparison {
  const candidateByName = new Map(candidate.results.map((result) => [result.name, result]));
  const regressions = baseline.results
    .filter((base) => base.passed && candidateByName.get(base.name)?.passed === false)
    .map((base) => base.name);
  return {
    baseline: baseline.brain,
    candidate: candidate.brain,
    passRateDelta: candidate.passRate - baseline.passRate,
    avgStepsDelta: candidate.avgSteps - baseline.avgSteps,
    avgTokensDelta: candidate.avgTokens - baseline.avgTokens,
    regressions,
  };
}
