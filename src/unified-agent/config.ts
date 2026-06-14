// Configuration for a unified agent: which model, where its key comes from,
// how sessions persist, and the execution policy. Everything needed to stand
// up a runnable agent without touching code — the model is data, not a
// hardcoded object.

import type {
  CapabilityEntitlements,
  ExecutionPolicy,
} from "../../packages/capability-contract/src/index.js";
import type { Api, Model } from "../../packages/llm-core/src/index.js";
import type { SessionStoreConfig } from "../../packages/session-store/src/index.js";

/** Declarative model definition. `apiKeyEnv` names the env var holding the key
 * — the key itself never lives in config. `provider` is an open string used
 * for credential lookup, not a closed union. */
export interface ModelConfig {
  provider: string;
  api: Api;
  modelId: string;
  baseUrl: string;
  apiKeyEnv: string;
  displayName?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Full agent configuration. Only the model is required; the rest defaults to
 * an in-memory, ask-before-acting agent. */
export interface AgentConfig {
  model: ModelConfig;
  /** Agent mode = which brain drives the loop. Defaults to "standard". */
  mode?: "standard" | "deep";
  store?: SessionStoreConfig;
  policy?: ExecutionPolicy;
  systemPrompt?: string;
  entitlements?: CapabilityEntitlements;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Builds the llm-core Model an inference call needs from declarative config. */
export function buildModel(config: ModelConfig): Model {
  return {
    id: config.modelId,
    name: config.displayName ?? config.modelId,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning ?? false,
    input: ["text"],
    cost: config.cost ?? ZERO_COST,
    contextWindow: config.contextWindow ?? 128_000,
    maxTokens: config.maxTokens ?? 4096,
  };
}

/** DeepSeek chat over its OpenAI-compatible API. Key from DEEPSEEK_API_KEY. */
export const DEEPSEEK_MODEL: ModelConfig = {
  provider: "deepseek",
  api: "openai-completions",
  modelId: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  displayName: "DeepSeek Chat",
  contextWindow: 64_000,
  maxTokens: 8_000,
  cost: { input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 },
};
