// Unified agent assembly tests: a fake completion stands in for the model so
// the wiring (brain + inference port + sandbox router + store + runtime) is
// verified without credentials. Tool-call names use the encoded form a real
// model returns (dots become underscores) to exercise the decode path.
import { afterEach, describe, expect, it } from "vitest";
import type { CompleteFn } from "../../packages/brain-inference/src/index.js";
import type { AssistantMessage, Context, Model } from "../../packages/llm-core/src/index.js";
import type { RuntimeEvent } from "../../packages/loop-runtime/src/index.js";
import { MemorySandbox } from "../../packages/sandbox-core/src/index.js";
import { buildModel, createUnifiedAgent, DEEPSEEK_MODEL, type AgentConfig } from "./index.js";

interface ScriptStep {
  text?: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
}

function fakeComplete(script: ScriptStep[]): CompleteFn {
  let index = 0;
  return (model: Model) => {
    const step = script[index++] ?? { text: "done" };
    const content: AssistantMessage["content"] = [];
    if (step.text) {
      content.push({ type: "text", text: step.text });
    }
    for (const tc of step.toolCalls ?? []) {
      content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.args });
    }
    return Promise.resolve({
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: (step.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop",
      timestamp: 0,
    } satisfies AssistantMessage);
  };
}

const TEST_MODEL: AgentConfig["model"] = {
  provider: "test",
  api: "openai-completions",
  modelId: "test-model",
  baseUrl: "http://localhost",
  apiKeyEnv: "TEST_KEY",
};

function turnInput(userMessage: string) {
  return {
    sessionId: "s1",
    userMessage,
    binding: { kind: "cloud-general" as const },
    mode: { id: "standard", maxParallelToolCalls: 1, planningEnabled: false },
  };
}

const agents: { close(): void }[] = [];
afterEach(() => {
  for (const a of agents.splice(0)) {
    a.close();
  }
});

describe("createUnifiedAgent", () => {
  it("assembles a runnable agent that answers a plain question", async () => {
    const agent = createUnifiedAgent(
      { model: TEST_MODEL, policy: "auto" },
      { complete: fakeComplete([{ text: "Hello there." }]) },
    );
    agents.push(agent);

    const result = await agent.runtime.runTurn(turnInput("hi"));
    expect(result.status).toBe("finished");
    expect(result.responses).toEqual(["Hello there."]);
  });

  it("runs a tool orchestration turn over the default in-memory sandbox", async () => {
    const sandbox = new MemorySandbox();
    const agent = createUnifiedAgent(
      { model: TEST_MODEL, policy: "auto", systemPrompt: "You operate a workspace." },
      {
        complete: fakeComplete([
          { toolCalls: [{ id: "c1", name: "fs_write", args: { path: "a.txt", content: "hi" } }] },
          { text: "Wrote the file." },
        ]),
        sandboxProviders: [sandbox],
      },
    );
    agents.push(agent);

    const result = await agent.runtime.runTurn(turnInput("write hi to a.txt"));
    expect(result.status).toBe("finished");
    expect(result.summary).toBe("Wrote the file.");
    // The encoded tool name decoded to fs.write and actually wrote on the sandbox.
    expect(sandbox.files.get("a.txt")).toBe("hi");
  });

  it("persists sessions when a sqlite store is configured", async () => {
    const config: AgentConfig = {
      model: TEST_MODEL,
      policy: "auto",
      store: { kind: "sqlite", path: ":memory:" },
    };
    const agent = createUnifiedAgent(config, { complete: fakeComplete([{ text: "stored" }]) });
    agents.push(agent);

    const result = await agent.runtime.runTurn(turnInput("remember this"));
    expect(result.status).toBe("finished");
    expect(agent.runtime.sessionEntries("s1").length).toBeGreaterThan(0);
  });

  it("routes ask-class calls to the approval gate", async () => {
    let asked = false;
    const sandbox = new MemorySandbox();
    const agent = createUnifiedAgent(
      { model: TEST_MODEL, policy: "ask" },
      {
        complete: fakeComplete([
          { toolCalls: [{ id: "c1", name: "fs_write", args: { path: "a.txt", content: "x" } }] },
          { text: "done" },
        ]),
        sandboxProviders: [sandbox],
        approvalGate: {
          decide: () => {
            asked = true;
            return Promise.resolve("deny");
          },
        },
      },
    );
    agents.push(agent);

    await agent.runtime.runTurn(turnInput("write x"));
    expect(asked).toBe(true);
    expect(sandbox.files.has("a.txt")).toBe(false);
  });
});

// Routes by prompt content, not call order, because team-mode subtasks run
// concurrently and interleave with the orchestrator's calls.
function teamComplete(): CompleteFn {
  const build = (model: Model, text: string, toolName?: string): AssistantMessage => {
    const content: AssistantMessage["content"] = [];
    if (text) {
      content.push({ type: "text", text });
    }
    if (toolName) {
      content.push({ type: "toolCall", id: "t", name: toolName, arguments: {} });
    }
    return {
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: toolName ? "toolUse" : "stop",
      timestamp: 0,
    };
  };
  return (model: Model, context: Context) => {
    const system = context.systemPrompt ?? "";
    if (system.includes("independent subtasks")) {
      return Promise.resolve(build(model, "1. First part\n2. Second part"));
    }
    if (system.includes("Synthesize")) {
      return Promise.resolve(build(model, "Final combined answer."));
    }
    // Subtask worker: list once, then finish.
    const hasToolResult = context.messages.some((message) => message.role === "toolResult");
    return Promise.resolve(
      hasToolResult ? build(model, "subtask done") : build(model, "", "fs_list"),
    );
  };
}

describe("team mode", () => {
  it("passes subtask tool telemetry through to the shared sink", async () => {
    const events: RuntimeEvent[] = [];
    const agent = createUnifiedAgent(
      { model: TEST_MODEL, mode: "team", policy: "auto" },
      {
        complete: teamComplete(),
        sandboxProviders: [new MemorySandbox()],
        telemetry: (event) => events.push(event),
      },
    );
    agents.push(agent);

    const result = await agent.runtime.runTurn(turnInput("do two things"));
    expect(result.status).toBe("finished");
    expect(result.summary).toBe("Final combined answer.");

    // Each delegated subtask ran a tool, and those events reached the sink
    // tagged with the subtask session id.
    const subtaskToolEvents = events.filter(
      (event) => event.kind === "tool_call_finished" && event.sessionId.includes(":sub:"),
    );
    expect(subtaskToolEvents.length).toBeGreaterThanOrEqual(2);
  });
});

describe("buildModel and presets", () => {
  it("fills llm-core model fields from config with defaults", () => {
    const model = buildModel(TEST_MODEL);
    expect(model).toMatchObject({
      id: "test-model",
      name: "test-model",
      api: "openai-completions",
      provider: "test",
      contextWindow: 128_000,
      maxTokens: 4096,
    });
  });

  it("exposes a DeepSeek preset pointing at the OpenAI-compatible endpoint", () => {
    expect(DEEPSEEK_MODEL).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    });
  });
});
