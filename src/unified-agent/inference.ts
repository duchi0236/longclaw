// Production inference wiring: builds the completion function from config by
// registering OpenClaw's built-in providers and reading the API key from the
// env var the config names. Kept separate from agent.ts so the assembly layer
// stays free of the LLM runtime and remains testable with a fake completion.

import type { CompleteFn } from "../../packages/brain-inference/src/index.js";
import { completeSimple } from "../../packages/llm-runtime/src/index.js";
import { registerBuiltInApiProviders } from "../llm/providers/register-builtins.js";
import type { ModelConfig } from "./config.js";

/** Builds a real completion function for a model config. The API key is read
 * lazily on first use, not at construction: brains that never call inference
 * (e.g. the ACP brain, which delegates the turn to an external harness) must be
 * able to start without a key. A model-driven brain still fails fast — on its
 * first completion call — with the same clear message. */
export function createCompleteFromConfig(modelConfig: ModelConfig): CompleteFn {
  registerBuiltInApiProviders();
  return (model, context) => {
    const apiKey = process.env[modelConfig.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`missing API key: set ${modelConfig.apiKeyEnv}`);
    }
    return completeSimple(model, context, { apiKey, maxTokens: model.maxTokens });
  };
}
