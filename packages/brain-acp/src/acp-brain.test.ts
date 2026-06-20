// ACP brain tests: a scripted ACP transport plays Claude Code while the REAL
// loop runtime and in-memory sandbox execute the decisions. The assertions pin
// the contract that matters: the agent's tool requests run in OpenClaw's
// sandbox (behind the approval gate), results are fed back over ACP, the final
// message ends the turn — and the inference port is never called (this brain
// delegates, it does not prompt a model).
import { describe, expect, it } from "vitest";
import type { InferencePort } from "../../brain-contract/src/index.js";
import { LoopRuntime, type ApprovalGate } from "../../loop-runtime/src/index.js";
import {
  CORE_CAPABILITY_MANIFESTS,
  MemorySandbox,
  SandboxRouter,
} from "../../sandbox-core/src/index.js";
import { createAcpBrain } from "./acp-brain.js";
import type { AcpSessionTransport, AcpStep, AcpToolResult } from "./acp-transport.js";

const ACP_MODE = { id: "acp", maxParallelToolCalls: 1, planningEnabled: false };

/** A transport that replays scripted agent steps and records what it received. */
function scriptedTransport(steps: AcpStep[]) {
  let index = 0;
  const prompts: { sessionId: string; userText: string }[] = [];
  const toolResults: { sessionId: string; callId: string; result: AcpToolResult }[] = [];
  const next = (): AcpStep => steps[index++] ?? { kind: "final", text: "[script exhausted]" };
  const transport: AcpSessionTransport = {
    prompt: (sessionId, userText) => {
      prompts.push({ sessionId, userText });
      return Promise.resolve(next());
    },
    provideToolResult: (sessionId, callId, result) => {
      toolResults.push({ sessionId, callId, result });
      return Promise.resolve(next());
    },
  };
  return { transport, prompts, toolResults };
}

/** Inference port that fails loudly: the ACP brain must never call a model. */
const throwingInference: InferencePort = () =>
  Promise.reject(new Error("ACP brain must not call the inference port"));

const autoApprove: ApprovalGate = { decide: () => Promise.resolve("allow") };

function buildHarness(steps: AcpStep[]) {
  const sandbox = new MemorySandbox();
  const router = new SandboxRouter();
  router.register(sandbox);
  const script = scriptedTransport(steps);
  const runtime = new LoopRuntime({
    brain: createAcpBrain({ transport: script.transport }),
    manifests: CORE_CAPABILITY_MANIFESTS,
    router,
    inference: throwingInference,
    approvalGate: autoApprove,
    policy: "auto",
  });
  return { runtime, sandbox, script };
}

describe("createAcpBrain", () => {
  it("exposes the acp descriptor", () => {
    const brain = createAcpBrain({ transport: scriptedTransport([]).transport });
    expect(brain.descriptor.id).toBe("acp");
  });
});

describe("ACP brain over the real runtime", () => {
  it("runs the agent's tool requests in the sandbox and feeds results back", async () => {
    const { runtime, sandbox, script } = buildHarness([
      { kind: "tool_request", callId: "a1", capability: "fs.write", args: { path: "notes.txt", content: "hi" } },
      { kind: "tool_request", callId: "a2", capability: "fs.read", args: { path: "notes.txt" } },
      { kind: "final", text: "wrote and read: hi" },
    ]);

    const result = await runtime.runTurn({
      sessionId: "s1",
      userMessage: "save a note then read it",
      binding: { kind: "cloud-general" },
      mode: ACP_MODE,
    });

    expect(result.status).toBe("finished");
    expect(result.responses).toContain("wrote and read: hi");
    // The write really happened inside OpenClaw's sandbox.
    expect(sandbox.files.get("notes.txt")).toBe("hi");
    // The user prompt reached the agent verbatim.
    expect(script.prompts).toEqual([{ sessionId: "s1", userText: "save a note then read it" }]);
    // Both tool results were fed back over ACP, correlated by ACP call id.
    expect(script.toolResults.map((r) => r.callId)).toEqual(["a1", "a2"]);
    expect(script.toolResults[1]?.result).toEqual({ isError: false, output: "hi" });
  });

  it("feeds sandbox errors back to the agent", async () => {
    const { runtime, script } = buildHarness([
      { kind: "tool_request", callId: "b1", capability: "fs.read", args: { path: "missing.txt" } },
      { kind: "final", text: "could not read it" },
    ]);

    const result = await runtime.runTurn({
      sessionId: "s2",
      userMessage: "read missing",
      binding: { kind: "cloud-general" },
      mode: ACP_MODE,
    });

    expect(result.status).toBe("finished");
    expect(result.responses).toContain("could not read it");
    expect(script.toolResults).toHaveLength(1);
    expect(script.toolResults[0]?.result.isError).toBe(true);
    expect(script.toolResults[0]?.result.output).toMatch(/file not found/);
  });

  it("handles a turn that finishes with no tool calls", async () => {
    const { runtime, sandbox, script } = buildHarness([{ kind: "final", text: "hello there" }]);

    const result = await runtime.runTurn({
      sessionId: "s3",
      userMessage: "just say hi",
      binding: { kind: "cloud-general" },
      mode: ACP_MODE,
    });

    expect(result.status).toBe("finished");
    expect(result.responses).toContain("hello there");
    expect(script.toolResults).toHaveLength(0);
    expect(sandbox.invocations).toHaveLength(0);
  });

  it("carries multiple turns on the same session", async () => {
    const { runtime, script } = buildHarness([
      { kind: "final", text: "first answer" },
      { kind: "final", text: "second answer" },
    ]);

    await runtime.runTurn({ sessionId: "s4", userMessage: "q1", binding: { kind: "cloud-general" }, mode: ACP_MODE });
    const second = await runtime.runTurn({ sessionId: "s4", userMessage: "q2", binding: { kind: "cloud-general" }, mode: ACP_MODE });

    expect(second.responses).toContain("second answer");
    expect(script.prompts.map((p) => p.userText)).toEqual(["q1", "q2"]);
  });
});
