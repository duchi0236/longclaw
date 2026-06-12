// Session persistence through the runtime: a session written by one runtime
// instance resumes in a fresh instance from the SQLite store alone — the
// instance-pool scenario where a user's runtime hibernates and wakes up
// elsewhere. Idempotency keys must survive so a replayed brain cannot
// re-execute spent calls.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { BrainAction, BrainContext } from "../../brain-contract/src/index.js";
import { createStandardBrain } from "../../brain-standard/src/index.js";
import {
  CORE_CAPABILITY_MANIFESTS,
  MemorySandbox,
  SandboxRouter,
} from "../../sandbox-core/src/index.js";
import { SqliteSessionStore } from "../../session-store/src/index.js";
import { LoopRuntime, type LoopRuntimeDeps } from "./runtime.js";

const STANDARD_MODE = { id: "standard", maxParallelToolCalls: 1, planningEnabled: false };

function buildRuntime(db: DatabaseSync, overrides: Partial<LoopRuntimeDeps> = {}) {
  const sandbox = new MemorySandbox({ execScript: (cmd) => ({ output: `ok:${cmd}` }) });
  const router = new SandboxRouter();
  router.register(sandbox);
  return {
    sandbox,
    runtime: new LoopRuntime({
      brain: createStandardBrain(),
      manifests: CORE_CAPABILITY_MANIFESTS,
      router,
      inference: () => Promise.resolve({ text: "stub", tokensUsed: 1 }),
      approvalGate: { decide: () => Promise.resolve("allow") },
      policy: "auto",
      store: new SqliteSessionStore(db),
      ...overrides,
    }),
  };
}

function turnInput(userMessage: string) {
  return {
    sessionId: "session-1",
    userMessage,
    binding: { kind: "cloud-general" as const },
    mode: STANDARD_MODE,
  };
}

describe("session persistence across runtime instances", () => {
  it("resumes a conversation in a fresh runtime with full context", async () => {
    const db = new DatabaseSync(":memory:");

    // First runtime instance: a tool-using turn driven by the standard brain.
    const first = buildRuntime(db, {
      inference: (request) => {
        const askedBefore = request.messages.some((e) => e.kind === "tool_result");
        return Promise.resolve(
          askedBefore
            ? { text: "Saved your note.", tokensUsed: 5 }
            : {
                text: "",
                toolCalls: [
                  { id: "a", name: "fs.write", args: { path: "note.txt", content: "remember" } },
                ],
                tokensUsed: 5,
              },
        );
      },
    });
    const firstResult = await first.runtime.runTurn(turnInput("save a note"));
    expect(firstResult.status).toBe("finished");

    // Second runtime instance: same database, brand-new process state. The
    // model echoes how many entries it can see to prove history arrived.
    const second = buildRuntime(db, {
      inference: (request) =>
        Promise.resolve({ text: `I can see ${request.messages.length} entries.`, tokensUsed: 5 }),
    });
    const secondResult = await second.runtime.runTurn(turnInput("do you remember?"));

    expect(secondResult.status).toBe("finished");
    // 5 persisted from turn one (user, tool_call, tool_result, assistant…)
    // plus the new user message; exact count pins the hydration path.
    const hydrated = second.runtime.sessionEntries("session-1");
    expect(hydrated.length).toBeGreaterThan(5);
    expect(hydrated[0]).toEqual({ kind: "user", text: "save a note" });
    expect(secondResult.responses[0]).toBe(`I can see ${hydrated.length - 1} entries.`);
  });

  it("blocks idempotency keys spent before the restart", async () => {
    const db = new DatabaseSync(":memory:");
    const spentKey = "k-spent";

    // Tries the same key at the start of every turn; reports what happened.
    const replayingBrain = {
      descriptor: { id: "replayer", version: "1.0.0", capabilitiesRequired: [] },
      nextAction(ctx: BrainContext): Promise<BrainAction> {
        const last = ctx.entries.at(-1);
        if (last?.kind === "user") {
          return Promise.resolve({
            kind: "tool_call" as const,
            calls: [{ capability: "fs.list", args: {}, idempotencyKey: spentKey }],
          });
        }
        if (last?.kind === "system") {
          return Promise.resolve({ kind: "finish" as const, summary: last.text });
        }
        return Promise.resolve({ kind: "finish" as const, summary: "done" });
      },
    };

    const first = buildRuntime(db, { brain: replayingBrain });
    await first.runtime.runTurn(turnInput("list things"));
    expect(first.sandbox.invocations).toHaveLength(1);

    // Fresh instance, same store: the brain tries the same key again and the
    // runtime must reject it from rehydrated state, not process memory.
    const second = buildRuntime(db, { brain: replayingBrain });
    const result = await second.runtime.runTurn(turnInput("list things again"));

    expect(second.sandbox.invocations).toHaveLength(0);
    expect(result.summary).toContain(spentKey);
  });

  it("persists plan state across instances", async () => {
    const db = new DatabaseSync(":memory:");
    const planningBrain = {
      descriptor: { id: "planner", version: "1.0.0", capabilitiesRequired: [] },
      nextAction(ctx: BrainContext): Promise<BrainAction> {
        if (!ctx.plan) {
          return Promise.resolve({
            kind: "plan",
            plan: {
              revision: 1,
              steps: [{ id: "s1", title: "step one", status: "pending" as const }],
            },
          });
        }
        return Promise.resolve({ kind: "finish", summary: `plan rev ${ctx.plan.revision}` });
      },
    };

    const first = buildRuntime(db, { brain: planningBrain });
    await first.runtime.runTurn(turnInput("plan it"));

    const second = buildRuntime(db, { brain: planningBrain });
    const result = await second.runtime.runTurn(turnInput("continue"));
    expect(result.summary).toBe("plan rev 1");
  });
});
