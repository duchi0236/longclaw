// Inference port adapter: turns OpenClaw's single-shot completion into the
// InferencePort the runtime injects into a brain. The actual completion call
// is injected (production passes completeSimple from @openclaw/llm-runtime),
// so this package stays a pure type-level bridge — testable without
// credentials or a provider registry.

import type { InferencePort } from "../../brain-contract/src/index.js";
import type { AssistantMessage, Context, Model } from "../../llm-core/src/index.js";
import {
  assistantMessageToResult,
  entriesToMessages,
  toolDefinitionsToTools,
} from "./conversation-bridge.js";

/** Single-shot completion: inject `completeSimple` from llm-runtime here. */
export type CompleteFn = (model: Model, context: Context) => Promise<AssistantMessage>;

/** Dependencies for the inference port adapter. */
export interface InferenceAdapterDeps {
  /** Resolves a logical tier (fast/strong) to a concrete model. */
  resolveModel(tier: "fast" | "strong"): Model;
  /** Runs one non-streaming completion. */
  complete: CompleteFn;
}

/** Builds the InferencePort a brain calls through. */
export function createInferencePort(deps: InferenceAdapterDeps): InferencePort {
  return async (request) => {
    const model = deps.resolveModel(request.tier);
    const context: Context = {
      ...(request.system ? { systemPrompt: request.system } : {}),
      messages: entriesToMessages(request.messages, model),
      ...(request.tools ? { tools: toolDefinitionsToTools(request.tools) } : {}),
    };
    const message = await deps.complete(model, context);
    return assistantMessageToResult(message);
  };
}
