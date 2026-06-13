// Translation between the brain's neutral conversation entries and OpenClaw's
// llm-core message structure. The brain contract stays provider-agnostic
// (flat ConversationEntry log); this bridge folds that log back into the
// AssistantMessage/ToolResultMessage shape llm-core providers require, and
// maps the model's reply back into a neutral InferenceResult.

import type {
  ConversationEntry,
  InferenceResult,
  InferenceToolDefinition,
} from "../../brain-contract/src/index.js";
import type {
  AssistantMessage,
  Message,
  Model,
  TextContent,
  Tool,
  ToolCall,
  Usage,
} from "../../llm-core/src/index.js";

// Rebuilt history messages carry no real timestamps or token accounting;
// providers serialize content and tool-call ids, not these metadata fields.
const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface PendingAssistant {
  text: string | null;
  toolCalls: ToolCall[];
}

function buildAssistant(pending: PendingAssistant, model: Model): AssistantMessage | null {
  const content: AssistantMessage["content"] = [];
  if (pending.text) {
    content.push({ type: "text", text: pending.text });
  }
  content.push(...pending.toolCalls);
  // An assistant turn with no content is never sent: providers reject empty
  // content, and the standard brain only emits non-empty text or tool calls.
  if (content.length === 0) {
    return null;
  }
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: pending.toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp: 0,
  };
}

/**
 * Folds the flat entry log into llm-core messages. Assistant text and the
 * tool calls that followed it collapse into one AssistantMessage so each
 * tool_result lines up with a preceding tool_use — the ordering Anthropic and
 * other providers require. Runtime `system` feedback (e.g. rejected actions)
 * is injected as a user message so the model sees it; llm-core has no
 * system-role message, only Context.systemPrompt.
 */
export function entriesToMessages(entries: readonly ConversationEntry[], model: Model): Message[] {
  const messages: Message[] = [];
  let pending: PendingAssistant | null = null;

  const flush = (): void => {
    if (!pending) {
      return;
    }
    const assistant = buildAssistant(pending, model);
    if (assistant) {
      messages.push(assistant);
    }
    pending = null;
  };

  for (const entry of entries) {
    switch (entry.kind) {
      case "user":
      case "system":
        flush();
        messages.push({ role: "user", content: entry.text, timestamp: 0 });
        break;
      case "assistant":
        pending ??= { text: null, toolCalls: [] };
        pending.text = entry.text;
        break;
      case "tool_call":
        pending ??= { text: null, toolCalls: [] };
        pending.toolCalls.push({
          type: "toolCall",
          id: entry.callId,
          name: entry.capability,
          arguments: (entry.args ?? {}) as Record<string, unknown>,
        });
        break;
      case "tool_result":
        // A tool result must follow the assistant message carrying its call.
        flush();
        messages.push({
          role: "toolResult",
          toolCallId: entry.callId,
          toolName: entry.capability,
          content: [{ type: "text", text: entry.output }],
          isError: entry.isError,
          timestamp: 0,
        });
        break;
    }
  }
  flush();
  return messages;
}

// Capability names are dotted family paths (fs.read), but OpenAI/DeepSeek tool
// names must match ^[a-zA-Z0-9_-]+$ — no dots. Encode the dot as an underscore
// (snake_case, which models emit faithfully) and decode on the way back.
// Capability name segments never contain underscores (see
// CAPABILITY_NAME_PATTERN), so the mapping is unambiguous and reversible.
const DOT = ".";
const ENCODED_DOT = "_";

export function encodeToolName(capability: string): string {
  return capability.replaceAll(DOT, ENCODED_DOT);
}

export function decodeToolName(toolName: string): string {
  return toolName.replaceAll(ENCODED_DOT, DOT);
}

/** Maps neutral tool definitions to llm-core tools. Tool names are encoded to
 * satisfy provider name constraints; the capability input schema is already a
 * JSON Schema, which providers consume as the parameter schema directly. */
export function toolDefinitionsToTools(definitions: readonly InferenceToolDefinition[]): Tool[] {
  return definitions.map((def) => ({
    name: encodeToolName(def.name),
    description: def.description,
    parameters: def.inputSchema as unknown as Tool["parameters"],
  }));
}

/** Maps the model's reply back into a neutral InferenceResult. A model error
 * (stopReason "error") surfaces as text so the turn does not silently look
 * like "no output"; tool names are decoded back to capability names. */
export function assistantMessageToResult(message: AssistantMessage): InferenceResult {
  const text = message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (message.stopReason === "error") {
    return {
      text: text || (message.errorMessage ?? "inference failed"),
      tokensUsed: message.usage.totalTokens,
    };
  }
  const toolCalls = message.content
    .filter((block): block is ToolCall => block.type === "toolCall")
    .map((block) => ({ id: block.id, name: decodeToolName(block.name), args: block.arguments }));
  return {
    text,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    tokensUsed: message.usage.totalTokens,
  };
}
