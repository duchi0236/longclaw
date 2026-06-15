// Agent assembly: turns an AgentConfig plus an injected completion function
// into a ready LoopRuntime. This layer is provider-agnostic and testable —
// the LLM call is injected (see inference.ts for the production wiring), the
// sandbox providers default to in-memory, and the store comes from config.

import type { AgentBrain, InferencePort } from "../../packages/brain-contract/src/index.js";
import { createDeepBrain } from "../../packages/brain-deep/src/index.js";
import { createInferencePort, type CompleteFn } from "../../packages/brain-inference/src/index.js";
import { createStandardBrain } from "../../packages/brain-standard/src/index.js";
import { createTeamBrain } from "../../packages/brain-team/src/index.js";
import type { ExecutionPolicy } from "../../packages/capability-contract/src/index.js";
import {
  LoopRuntime,
  type ApprovalGate,
  type RuntimeEventSink,
  type SubtaskRunner,
} from "../../packages/loop-runtime/src/index.js";
import {
  CORE_CAPABILITY_MANIFESTS,
  MemorySandbox,
  SandboxRouter,
  type SandboxProvider,
} from "../../packages/sandbox-core/src/index.js";
import { createSessionStore } from "../../packages/session-store/src/index.js";
import { buildModel, type AgentConfig } from "./config.js";

/** Injected dependencies for assembly. `complete` is required; production
 * passes createCompleteFromConfig, tests pass a fake. */
export interface UnifiedAgentDeps {
  complete: CompleteFn;
  /** Approval decisions for ask-class calls; defaults to auto-allow. */
  approvalGate?: ApprovalGate;
  /** Sandbox backends to register; defaults to a single in-memory sandbox. */
  sandboxProviders?: SandboxProvider[];
  /** Telemetry sink for runtime events (tool calls, approvals, turns). */
  telemetry?: RuntimeEventSink;
}

/** A built agent plus ownership of its resources. */
export interface UnifiedAgent {
  runtime: LoopRuntime;
  /** Releases the session store and any owned resources. */
  close(): void;
}

const AUTO_APPROVE: ApprovalGate = { decide: () => Promise.resolve("allow") };

type BrainOptions = { systemPrompt?: string };

function selectBrain(mode: AgentConfig["mode"], options: BrainOptions): AgentBrain {
  if (mode === "deep") {
    return createDeepBrain(options);
  }
  if (mode === "team") {
    return createTeamBrain(options);
  }
  return createStandardBrain(options);
}

/** Shared execution surface a subtask sub-agent runs on. */
interface WorkerContext {
  inference: InferencePort;
  router: SandboxRouter;
  approvalGate: ApprovalGate;
  policy: ExecutionPolicy;
  brainOptions: BrainOptions;
  /** Telemetry sink shared with the orchestrator; subtask events carry their
   * own `<parent>:sub:<title>` session id so consumers can tell them apart. */
  telemetry?: RuntimeEventSink;
}

/** Runs one subtask as a standard-brain sub-agent on the SAME inference,
 * sandbox, and tools as the orchestrator — delegation without a second stack.
 * Each subtask gets its own session so parallel runs don't collide. */
function runSubtask(
  parentSessionId: string,
  spec: { title: string; instructions: string },
  ctx: WorkerContext,
): Promise<string> {
  const subRuntime = new LoopRuntime({
    brain: createStandardBrain(ctx.brainOptions),
    manifests: CORE_CAPABILITY_MANIFESTS,
    router: ctx.router,
    inference: ctx.inference,
    approvalGate: ctx.approvalGate,
    policy: ctx.policy,
    ...(ctx.telemetry ? { telemetry: ctx.telemetry } : {}),
  });
  return subRuntime
    .runTurn({
      sessionId: `${parentSessionId}:sub:${spec.title}`,
      userMessage: spec.instructions,
      binding: { kind: "cloud-general" },
      mode: { id: "standard", maxParallelToolCalls: 1, planningEnabled: false },
    })
    .then((result) => result.summary ?? result.responses.join(" ") ?? "(no result)");
}

/** Assembles a runnable agent from config and injected dependencies. */
export function createUnifiedAgent(config: AgentConfig, deps: UnifiedAgentDeps): UnifiedAgent {
  const model = buildModel(config.model);
  const inference = createInferencePort({ resolveModel: () => model, complete: deps.complete });
  const approvalGate = deps.approvalGate ?? AUTO_APPROVE;
  const policy = config.policy ?? "ask";
  const brainOptions: BrainOptions = config.systemPrompt
    ? { systemPrompt: config.systemPrompt }
    : {};

  const router = new SandboxRouter();
  for (const provider of deps.sandboxProviders ?? [new MemorySandbox()]) {
    router.register(provider);
  }

  const storeHandle = config.store ? createSessionStore(config.store) : undefined;

  // Team mode delegates subtasks to standard-brain sub-agents; other modes
  // run a single brain with no spawning.
  const spawnSubtask: SubtaskRunner | undefined =
    config.mode === "team"
      ? (parentSessionId, spec) =>
          runSubtask(parentSessionId, spec, {
            inference,
            router,
            approvalGate,
            policy,
            brainOptions,
            ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
          })
      : undefined;

  const runtime = new LoopRuntime({
    brain: selectBrain(config.mode, brainOptions),
    manifests: CORE_CAPABILITY_MANIFESTS,
    router,
    inference,
    approvalGate,
    policy,
    ...(config.entitlements ? { entitlements: config.entitlements } : {}),
    ...(storeHandle ? { store: storeHandle.store } : {}),
    ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
    ...(spawnSubtask ? { spawnSubtask } : {}),
  });

  return {
    runtime,
    close: () => storeHandle?.close(),
  };
}
