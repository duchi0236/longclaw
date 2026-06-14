// Unified agent: config-driven assembly of the brain/tool-separation stack
// into a runnable agent. `startAgent` is the one-call production entry point;
// `createUnifiedAgent` is the testable core that takes an injected completion.
import { createUnifiedAgent, type UnifiedAgent, type UnifiedAgentDeps } from "./agent.js";
import type { AgentConfig } from "./config.js";
import { createCompleteFromConfig } from "./inference.js";

export * from "./agent.js";
export * from "./config.js";
export * from "./inference.js";

/** Builds a runnable agent wired to the real LLM provider for its model. */
export function startAgent(
  config: AgentConfig,
  deps?: Omit<UnifiedAgentDeps, "complete">,
): UnifiedAgent {
  return createUnifiedAgent(config, {
    complete: createCompleteFromConfig(config.model),
    ...deps,
  });
}
