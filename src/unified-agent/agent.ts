// Agent assembly: turns an AgentConfig plus an injected completion function
// into a ready LoopRuntime. This layer is provider-agnostic and testable —
// the LLM call is injected (see inference.ts for the production wiring), the
// sandbox providers default to in-memory, and the store comes from config.

import { createInferencePort, type CompleteFn } from "../../packages/brain-inference/src/index.js";
import { createStandardBrain } from "../../packages/brain-standard/src/index.js";
import { LoopRuntime, type ApprovalGate } from "../../packages/loop-runtime/src/index.js";
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
}

/** A built agent plus ownership of its resources. */
export interface UnifiedAgent {
  runtime: LoopRuntime;
  /** Releases the session store and any owned resources. */
  close(): void;
}

const AUTO_APPROVE: ApprovalGate = { decide: () => Promise.resolve("allow") };

/** Assembles a runnable agent from config and injected dependencies. */
export function createUnifiedAgent(config: AgentConfig, deps: UnifiedAgentDeps): UnifiedAgent {
  const model = buildModel(config.model);

  const router = new SandboxRouter();
  for (const provider of deps.sandboxProviders ?? [new MemorySandbox()]) {
    router.register(provider);
  }

  const storeHandle = config.store ? createSessionStore(config.store) : undefined;

  const runtime = new LoopRuntime({
    brain: createStandardBrain(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    manifests: CORE_CAPABILITY_MANIFESTS,
    router,
    inference: createInferencePort({ resolveModel: () => model, complete: deps.complete }),
    approvalGate: deps.approvalGate ?? AUTO_APPROVE,
    policy: config.policy ?? "ask",
    ...(config.entitlements ? { entitlements: config.entitlements } : {}),
    ...(storeHandle ? { store: storeHandle.store } : {}),
  });

  return {
    runtime,
    close: () => storeHandle?.close(),
  };
}
