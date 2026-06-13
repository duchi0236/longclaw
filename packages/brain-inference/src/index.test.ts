// Brain inference tests: pure conversation-bridge translation, then an
// integration run proving the adapter drives the standard brain through the
// real loop runtime with a scripted completion (no credentials needed). The
// integration test pins the hard part — that a tool result lines up with the
// assistant message carrying its call after the entry log is folded back.
import { describe, expect, it } from "vitest";
import type { ConversationEntry } from "../../brain-contract/src/index.js";
import { createStandardBrain } from "../../brain-standard/src/index.js";
import type {
  AssistantMessage,
  Context,
  Model,
  ToolCall,
  Usage,
} from "../../llm-core/src/index.js";
import { LoopRuntime } from "../../loop-runtime/src/index.js";
import {
  CORE_CAPABILITY_MANIFESTS,
  MemorySandbox,
  SandboxRouter,
} from "../../sandbox-core/src/index.js";
import {
  assistantMessageToResult,
  createInferencePort,
  entriesToMessages,
  toolDefinitionsToTools,
} from "./index.js";

const MODEL = {
  id: "claude-test",
  name: "Test",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} as Model;

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  text: string,
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [],
  totalTokens = 10,
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (text) {
    content.push({ type: "text", text });
  }
  for (const tc of toolCalls) {
    content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments });
  }
  return {
    role: "assistant",
    content,
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: { ...ZERO_USAGE, output: totalTokens, totalTokens },
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp: 0,
  };
}

describe("entriesToMessages", () => {
  it("folds assistant text and tool calls into one message, pairing results", () => {
    const entries: ConversationEntry[] = [
      { kind: "user", text: "fix it" },
      { kind: "assistant", text: "looking" },
      {
        kind: "tool_call",
        callId: "s1:1",
        capability: "fs.read",
        args: { path: "a.ts" },
        idempotencyKey: "k1",
      },
      {
        kind: "tool_result",
        callId: "s1:1",
        capability: "fs.read",
        isError: false,
        output: "data",
      },
      { kind: "assistant", text: "done" },
    ];

    const messages = entriesToMessages(entries, MODEL);

    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: "user", content: "fix it", timestamp: 0 });

    const assistantMsg = messages[1] as AssistantMessage;
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.stopReason).toBe("toolUse");
    expect(assistantMsg.content).toEqual([
      { type: "text", text: "looking" },
      { type: "toolCall", id: "s1:1", name: "fs.read", arguments: { path: "a.ts" } },
    ]);

    expect(messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "s1:1",
      toolName: "fs.read",
      isError: false,
      content: [{ type: "text", text: "data" }],
    });
    expect(messages[3]).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("injects runtime system feedback as a user message", () => {
    const messages = entriesToMessages(
      [{ kind: "system", text: "action rejected: bad tool" }],
      MODEL,
    );
    expect(messages).toEqual([
      { role: "user", content: "action rejected: bad tool", timestamp: 0 },
    ]);
  });

  it("keeps multiple tool calls in one assistant message before their results", () => {
    const entries: ConversationEntry[] = [
      { kind: "tool_call", callId: "c1", capability: "fs.write", args: {}, idempotencyKey: "k1" },
      { kind: "tool_call", callId: "c2", capability: "exec.run", args: {}, idempotencyKey: "k2" },
      { kind: "tool_result", callId: "c1", capability: "fs.write", isError: false, output: "ok" },
      { kind: "tool_result", callId: "c2", capability: "exec.run", isError: false, output: "done" },
    ];
    const messages = entriesToMessages(entries, MODEL);
    const toolCallIds = (messages[0] as AssistantMessage).content
      .filter((c): c is ToolCall => c.type === "toolCall")
      .map((c) => c.id);
    expect(toolCallIds).toEqual(["c1", "c2"]);
    expect(messages.slice(1).map((m) => m.role)).toEqual(["toolResult", "toolResult"]);
  });
});

describe("toolDefinitionsToTools and assistantMessageToResult", () => {
  it("maps tool definitions to llm-core tools", () => {
    const tools = toolDefinitionsToTools([
      { name: "fs.read", description: "read a file", inputSchema: { type: "object" } },
    ]);
    expect(tools).toEqual([
      { name: "fs.read", description: "read a file", parameters: { type: "object" } },
    ]);
  });

  it("extracts text, tool calls, and token usage from an assistant message", () => {
    const result = assistantMessageToResult(
      assistant("here", [{ id: "x", name: "fs.read", arguments: { path: "a" } }], 42),
    );
    expect(result).toEqual({
      text: "here",
      toolCalls: [{ id: "x", name: "fs.read", args: { path: "a" } }],
      tokensUsed: 42,
    });
  });
});

describe("createInferencePort integration", () => {
  it("drives the standard brain through the runtime with folded history", async () => {
    const contexts: Context[] = [];
    const script = [
      assistant("Writing the fix.", [
        { id: "m1", name: "fs.write", arguments: { path: "a.ts", content: "x" } },
        { id: "m2", name: "exec.run", arguments: { command: "test" } },
      ]),
      assistant("All done."),
    ];
    let step = 0;
    const complete = (model: Model, context: Context) => {
      expect(model.id).toBe("claude-test");
      contexts.push(context);
      return Promise.resolve(script[step++]!);
    };

    const sandbox = new MemorySandbox({ execScript: (cmd) => ({ output: `ran:${cmd}` }) });
    const router = new SandboxRouter();
    router.register(sandbox);

    const runtime = new LoopRuntime({
      brain: createStandardBrain(),
      manifests: CORE_CAPABILITY_MANIFESTS,
      router,
      inference: createInferencePort({ resolveModel: () => MODEL, complete }),
      approvalGate: { decide: () => Promise.resolve("allow") },
      policy: "auto",
    });

    const result = await runtime.runTurn({
      sessionId: "s1",
      userMessage: "fix the bug",
      binding: { kind: "cloud-general" },
      mode: { id: "standard", maxParallelToolCalls: 1, planningEnabled: false },
    });

    expect(result.status).toBe("finished");
    expect(result.summary).toBe("All done.");
    expect(sandbox.files.get("a.ts")).toBe("x");

    // The second completion must see a valid history: every tool result is
    // preceded by an assistant message carrying its tool call, with ids paired
    // in order. Sequential-mode batches fold into assistant/toolResult pairs.
    expect(contexts).toHaveLength(2);
    const second = contexts[1]!.messages;
    const callIds = second
      .filter((m) => m.role === "assistant")
      .flatMap((m) =>
        (m as AssistantMessage).content
          .filter((c): c is ToolCall => c.type === "toolCall")
          .map((c) => c.id),
      );
    const resultIds = second
      .filter((m) => m.role === "toolResult")
      .map((m) => (m as { toolCallId: string }).toolCallId);
    expect(resultIds).toHaveLength(2);
    expect(resultIds).toEqual(callIds);

    // The first call advertised the capability tools to the model.
    expect(contexts[0]!.tools?.map((t) => t.name).toSorted()).toEqual([
      "exec.run",
      "fs.list",
      "fs.read",
      "fs.write",
    ]);
  });
});
