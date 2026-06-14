// Team brain v1: an orchestrator. It breaks a task into independent subtasks,
// delegates them as one spawn batch (the runtime runs them in parallel), then
// synthesizes the results into a final answer. It never calls a tool itself —
// the subtasks do, each running on the same tool stack via their own brain.
//
// Like the deep brain, this is purely a different decision policy. The spawn
// action and the subtask-results marker are contract features the runtime
// already provides; the team brain only decides when to delegate and how to
// combine what comes back.

import {
  SUBTASK_RESULTS_MARKER,
  type AgentBrain,
  type BrainAction,
  type BrainContext,
  type SubtaskSpec,
} from "../../brain-contract/src/index.js";

/** Build-time options for one team brain version. */
export interface TeamBrainOptions {
  /** System prompt prepended to decomposition and synthesis. */
  systemPrompt?: string;
  /** Model tier for decomposition. Defaults to the strong tier. */
  decomposeTier?: "fast" | "strong";
  /** Model tier for synthesis. Defaults to the strong tier. */
  synthesizeTier?: "fast" | "strong";
  /** Cap on subtasks delegated in one batch. Default 5. */
  maxSubtasks?: number;
  /** Brain id subtasks should run with; defaults to the runtime's worker brain. */
  subtaskBrainId?: string;
  /** Brain build version. */
  version?: string;
}

const TITLE_MAX = 60;

/** Parses a model's decomposition reply into subtask specs. */
function parseSubtasks(text: string, options: TeamBrainOptions): SubtaskSpec[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^[\s\-*\d.)]+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, options.maxSubtasks ?? 5)
    .map((line) => {
      const subtask: SubtaskSpec = {
        title: line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line,
        instructions: line,
      };
      if (options.subtaskBrainId) {
        subtask.brainId = options.subtaskBrainId;
      }
      return subtask;
    });
}

function decomposeSystem(base: string | undefined): string {
  const prefix = base ? `${base}\n\n` : "";
  return `${prefix}Break the task into independent subtasks that can run in parallel, each self-contained. Output ONLY the subtasks, one per line, no preamble. Do not do the work yet.`;
}

function synthesizeSystem(base: string | undefined): string {
  const prefix = base ? `${base}\n\n` : "";
  return `${prefix}The subtasks you delegated have finished; their results are in the conversation. Synthesize one final answer for the user from them. Do not delegate again.`;
}

function hasDelegated(ctx: BrainContext): boolean {
  return ctx.entries.some(
    (entry) => entry.kind === "system" && entry.text.startsWith(SUBTASK_RESULTS_MARKER),
  );
}

async function decompose(ctx: BrainContext, options: TeamBrainOptions): Promise<BrainAction> {
  const result = await ctx.infer({
    tier: options.decomposeTier ?? "strong",
    system: decomposeSystem(options.systemPrompt),
    messages: ctx.entries,
  });
  const subtasks = parseSubtasks(result.text, options);
  // Nothing to parallelize: fall back to a single subtask carrying the whole
  // request so the worker still does it instead of the orchestrator stalling.
  if (subtasks.length === 0) {
    const userText =
      ctx.entries.find((entry) => entry.kind === "user")?.text ?? "complete the task";
    return {
      kind: "spawn",
      subtasks: [{ title: "task", instructions: userText }],
    };
  }
  return { kind: "spawn", subtasks };
}

async function synthesize(ctx: BrainContext, options: TeamBrainOptions): Promise<BrainAction> {
  const result = await ctx.infer({
    tier: options.synthesizeTier ?? "strong",
    system: synthesizeSystem(options.systemPrompt),
    messages: ctx.entries,
  });
  return result.text
    ? { kind: "respond", text: result.text }
    : { kind: "finish", summary: "subtasks completed" };
}

async function decide(ctx: BrainContext, options: TeamBrainOptions): Promise<BrainAction> {
  // A trailing assistant message means synthesis already answered; end the turn.
  const last = ctx.entries.at(-1);
  if (last?.kind === "assistant") {
    return { kind: "finish", summary: last.text };
  }
  return hasDelegated(ctx) ? synthesize(ctx, options) : decompose(ctx, options);
}

/** Creates the team (orchestrator) brain. */
export function createTeamBrain(options: TeamBrainOptions = {}): AgentBrain {
  return {
    descriptor: {
      id: "team",
      version: options.version ?? "1.0.0",
      displayName: "Team",
      capabilitiesRequired: [],
    },
    nextAction: (ctx) => decide(ctx, options),
  };
}
