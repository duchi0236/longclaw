// Production inference wiring: builds the completion function from config by
// registering OpenClaw's built-in providers and reading the API key from the
// env var the config names. Kept separate from agent.ts so the assembly layer
// stays free of the LLM runtime and remains testable with a fake completion.

import type { CompleteFn } from "../../packages/brain-inference/src/index.js";
import { completeSimple } from "../../packages/llm-runtime/src/index.js";
import { registerBuiltInApiProviders } from "../llm/providers/register-builtins.js";
import type { ModelConfig } from "./config.js";

/** Builds a real completion function for a model config. Throws if the named
 * API key env var is unset, so misconfiguration fails fast at startup. */
export function createCompleteFromConfig(modelConfig: ModelConfig): CompleteFn {
  registerBuiltInApiProviders();
  const apiKey = process.env[modelConfig.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`missing API key: set ${modelConfig.apiKeyEnv}`);
  }
  return (model, context) => completeSimple(model, context, { apiKey, maxTokens: model.maxTokens });
}
