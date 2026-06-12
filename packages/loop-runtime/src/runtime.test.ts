// End-to-end runtime tests: a scripted brain drives the loop against the
// in-memory sandbox, proving the brain/tool separation works — policy
// gating, approvals, budgets, idempotency, suspension, and telemetry all
// happen in the runtime without either side knowing about the other.
import { describe, expect, it } from "vitest";
import type { AgentBrain, BrainAction, BrainContext } from "../../brain-contract/src/index.js";
import {
  MemorySandbox,
  SandboxRouter,
  CORE_CAPABILITY_MANIFESTS,
} from "../../sandbox-core/src/index.js";
import type { RuntimeEvent } from "./events.js";
import { LoopRuntime, type ApprovalGate, type LoopRuntimeDeps } from "./runtime.js";

const STANDARD_MODE = { id: "standard", maxParallelToolCalls: 1, planningEnabled: false };

/** Brain that replays a fixed list of actions, then finishes. */
function scriptedBrain(
  actions: (BrainAction | ((ctx: BrainContext) => BrainAction | Promise<BrainAction>))[],
  requirements: string[] = [],
): AgentBrain {
  let step = 0;
  return {
    descriptor: { id: "scripted", version: "1.0.0", capabilitiesRequired: requirements },
    async nextAction(ctx) {
      const next = actions[step] ?? { kind: "finish", summary: "script exhausted" };
      step += 1;
      return typeof next === "function" ? await next(ctx) : next;
    },
  };
}

const allowAll: ApprovalGate = { decide: () => Promise.resolve("allow") };

function buildRuntime(overrides: Partial<LoopRuntimeDeps> & { brain: AgentBrain }) {
  const sandbox = new MemorySandbox({ execScript: (cmd) => ({ output: `ok:${cmd}` }) });
  const router = new SandboxRouter();
  router.register(sandbox);
  const events: RuntimeEvent[] = [];
  const runtime = new LoopRuntime({
    manifests: CORE_CAPABILITY_MANIFESTS,
    router,
    inference: () => Promise.resolve({ text: "stub", tokensUsed: 10 }),
    approvalGate: allowAll,
    policy: "auto",
    telemetry: (event) => events.push(event),
    ...overrides,
  });
  return { runtime, sandbox, events };
}

function turnInput(overrides: Partial<Parameters<LoopRuntime["runTurn"]>[0]> = {}) {
  return {
    sessionId: "session-1",
    userMessage: "do the thing",
    binding: { kind: "cloud-general" as const },
    mode: STANDARD_MODE,
    ...overrides,
  };
}

describe("LoopRuntime end to end", () => {
  it("runs a full write → exec → respond → finish turn", async () => {
    const { runtime, sandbox, events } = buildRuntime({
      brain: scriptedBrain(
        [
          {
            kind: "tool_call",
            capability: "fs.write",
            args: { path: "src/fix.ts", content: "export const fixed = true;" },
            idempotencyKey: "write-1",
          },
          {
            kind: "tool_call",
            capability: "exec.run",
            args: { command: "npm test" },
            idempotencyKey: "exec-1",
          },
          { kind: "respond", text: "Fixed and tested." },
          { kind: "finish", summary: "wrote fix and ran tests" },
        ],
        ["fs.*", "exec.run"],
      ),
    });

    const result = await runtime.runTurn(turnInput());

    expect(result.status).toBe("finished");
    expect(result.summary).toBe("wrote fix and ran tests");
    expect(result.responses).toEqual(["Fixed and tested."]);
    expect(sandbox.files.get("src/fix.ts")).toBe("export const fixed = true;");
    expect(sandbox.invocations.map((i) => i.capability)).toEqual(["fs.write", "exec.run"]);

    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("turn_started");
    expect(kinds.at(-1)).toBe("turn_finished");
    expect(kinds.filter((k) => k === "tool_call_finished")).toHaveLength(2);

    const entries = runtime.sessionEntries("session-1");
    expect(entries.map((e) => e.kind)).toEqual([
      "user",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "assistant",
    ]);
  });

  it("routes ask-class calls through the approval gate and feeds denials back", async () => {
    const asked: string[] = [];
    const denyExec: ApprovalGate = {
      decide: (request) => {
        asked.push(`${request.capability}:${request.riskClass}`);
        return Promise.resolve("deny");
      },
    };
    const { runtime, sandbox } = buildRuntime({
      policy: "ask",
      approvalGate: denyExec,
      brain: scriptedBrain([
        {
          kind: "tool_call",
          capability: "exec.run",
          args: { command: "rm -rf dist" },
          idempotencyKey: "exec-1",
        },
        (ctx) => {
          const lastEntry = ctx.entries.at(-1);
          return {
            kind: "finish",
            summary: lastEntry?.kind === "system" ? lastEntry.text : "unexpected",
          };
        },
      ]),
    });

    const result = await runtime.runTurn(turnInput());

    expect(asked).toEqual(["exec.run:execute"]);
    expect(sandbox.invocations).toHaveLength(0);
    expect(result.summary).toBe("tool call denied by user: exec.run");
  });

  it("denies mutating calls outright under read-only policy without asking", async () => {
    let gateCalls = 0;
    const countingGate: ApprovalGate = {
      decide: () => {
        gateCalls += 1;
        return Promise.resolve("allow");
      },
    };
    const { runtime, sandbox } = buildRuntime({
      policy: "read-only",
      approvalGate: countingGate,
      brain: scriptedBrain([
        {
          kind: "tool_call",
          capability: "fs.write",
          args: { path: "a.txt", content: "x" },
          idempotencyKey: "w1",
        },
        { kind: "finish", summary: "done" },
      ]),
    });

    await runtime.runTurn(turnInput());

    expect(gateCalls).toBe(0);
    expect(sandbox.invocations).toHaveLength(0);
    const systemEntry = runtime.sessionEntries("session-1").find((e) => e.kind === "system");
    expect(systemEntry?.text).toContain("denied by read-only policy");
  });

  it("stops at the tool-call budget", async () => {
    let counter = 0;
    const { runtime, sandbox } = buildRuntime({
      brain: scriptedBrain(
        Array.from({ length: 10 }, () => () => {
          counter += 1;
          return {
            kind: "tool_call" as const,
            capability: "fs.list",
            args: {},
            idempotencyKey: `list-${counter}`,
          };
        }),
      ),
    });

    const result = await runtime.runTurn(turnInput({ budget: { toolCalls: 2 } }));

    expect(result.status).toBe("budget-exhausted");
    expect(result.detail).toBe("tool calls");
    expect(sandbox.invocations).toHaveLength(2);
  });

  it("stops when the brain exhausts the token budget through inference", async () => {
    const { runtime } = buildRuntime({
      inference: () => Promise.resolve({ text: "thinking", tokensUsed: 60 }),
      brain: scriptedBrain(
        Array.from({ length: 5 }, () => async (ctx: BrainContext): Promise<BrainAction> => {
          await ctx.infer({ tier: "fast", prompt: "think" });
          return { kind: "respond", text: "still thinking" };
        }),
      ),
    });

    const result = await runtime.runTurn(turnInput({ budget: { tokens: 100 } }));

    expect(result.status).toBe("budget-exhausted");
    expect(result.detail).toBe("tokens");
  });

  it("feeds contract violations back to the brain as system entries", async () => {
    const { runtime, events } = buildRuntime({
      brain: scriptedBrain([
        { kind: "tool_call", capability: "web.search", args: {}, idempotencyKey: "k1" },
        (ctx) => {
          const rejection = ctx.entries.find((e) => e.kind === "system");
          return { kind: "finish", summary: rejection?.text ?? "no rejection seen" };
        },
      ]),
    });

    const result = await runtime.runTurn(turnInput());

    expect(result.status).toBe("finished");
    expect(result.summary).toContain('capability "web.search" is not in this session\'s snapshot');
    expect(events.some((e) => e.kind === "action_rejected")).toBe(true);
  });

  it("suspends the session when the sandbox drops mid-turn", async () => {
    const { runtime, sandbox } = buildRuntime({
      brain: scriptedBrain([
        (ctx) => {
          void ctx;
          sandbox.setHealthy(false);
          return {
            kind: "tool_call",
            capability: "fs.list",
            args: {},
            idempotencyKey: "k1",
          };
        },
        { kind: "respond", text: "should never run" },
      ]),
    });

    const result = await runtime.runTurn(turnInput());

    expect(result.status).toBe("suspended");
    expect(result.detail).toContain("unavailable");
    const lastEntry = runtime.sessionEntries("session-1").at(-1);
    expect(lastEntry?.kind).toBe("tool_result");
  });

  it("refuses to run a brain whose requirements the sandbox cannot satisfy", async () => {
    const { runtime, sandbox } = buildRuntime({
      brain: scriptedBrain([{ kind: "respond", text: "hi" }], ["web.*"]),
    });

    const result = await runtime.runTurn(turnInput());

    expect(result.status).toBe("error");
    expect(result.detail).toContain("web.*");
    expect(sandbox.invocations).toHaveLength(0);
  });

  it("returns awaiting-user when the brain asks a question", async () => {
    const { runtime } = buildRuntime({
      brain: scriptedBrain([
        { kind: "ask_user", elicitation: { question: "Which branch should I target?" } },
      ]),
    });

    const result = await runtime.runTurn(turnInput());

    expect(result.status).toBe("awaiting-user");
    expect(result.question).toBe("Which branch should I target?");
  });

  it("runs spawned subtasks through the runner hook when enabled", async () => {
    const spawned: string[] = [];
    const { runtime } = buildRuntime({
      spawnSubtask: (_sessionId, spec) => {
        spawned.push(spec.title);
        return Promise.resolve("subtask ok");
      },
      brain: scriptedBrain([
        {
          kind: "spawn",
          subtask: { title: "refactor module A", instructions: "do it" },
        },
        (ctx) => {
          const note = ctx.entries.at(-1);
          return {
            kind: "finish",
            summary: note?.kind === "system" ? note.text : "missing subtask note",
          };
        },
      ]),
    });

    const result = await runtime.runTurn(turnInput());

    expect(spawned).toEqual(["refactor module A"]);
    expect(result.summary).toContain('subtask "refactor module A" finished: subtask ok');
  });

  it("keeps plan state across plan actions and validates revisions", async () => {
    const { runtime } = buildRuntime({
      brain: scriptedBrain([
        {
          kind: "plan",
          plan: { revision: 1, steps: [{ id: "s1", title: "investigate", status: "pending" }] },
        },
        // Wrong revision: must be rejected and surfaced as a system entry.
        {
          kind: "plan",
          plan: { revision: 5, steps: [{ id: "s1", title: "investigate", status: "done" }] },
        },
        (ctx) => ({
          kind: "finish",
          summary: `plan rev ${ctx.plan?.revision}; rejections: ${
            ctx.entries.filter((e) => e.kind === "system").length
          }`,
        }),
      ]),
    });

    const result = await runtime.runTurn(
      turnInput({ mode: { ...STANDARD_MODE, planningEnabled: true } }),
    );

    expect(result.summary).toBe("plan rev 1; rejections: 1");
  });
});
