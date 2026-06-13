// Brain inference package: the adapter that wires OpenClaw's LLM stack to the
// brain's InferencePort. Translates the neutral conversation log to llm-core
// messages and back; the completion call itself is injected.
export * from "./conversation-bridge.js";
export * from "./inference-port.js";
