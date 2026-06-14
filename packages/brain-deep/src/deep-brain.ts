// Deep brain v1: a plan-then-execute decision policy. Unlike the standard
// single-loop brain, it first asks the model to break the task into ordered
// steps (emitted as a plan action the runtime persists), then executes against
// that plan with the available tools until done.
//
// Crucially this brain touches NOTHING on the tool side. It runs on the same
// runtime, the same capability snapshot, and the same sandbox as the standard
// brain — it only decides differently. That is the whole point of the
// brain/tool split: a stronger agent mode is a new brain, not a rewrite.

import type {
  AgentBrain,
  BrainAction,
  BrainContext,
  PlanState,
  PlanStep,
} from "../../brain-contract/src/index.js";

/** Build-time options for one deep brain version. */
export interface DeepBrainOptions {
  /** System prompt prepended to planning and execution. */
  systemPrompt?: string;
  /** Model tier for the planning step. Defaults to the strong tier. */
  planningTier?: "fast" | "strong";
  /** Model tier for execution steps. Defaults to the fast tier. */
  executionTier?: "fast" | "strong";
  /** Cap on plan steps parsed from the model. Default 8. */
  maxSteps?: number;
  /** Brain build version. */
  version?: string;
}

/** Renders the current plan as a checklist for the execution prompt. */
function renderPlan(plan: PlanState): string {
  return plan.steps.map((step, index) => `${index + 1}. [${step.status}] ${step.title}`).join("\n");
}

/** Parses a model's plan reply into ordered steps, stripping bullets/numbers. */
function parsePlanSteps(text: string, maxSteps: number): PlanStep[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^[\s\-*\d.)]+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, maxSteps)
    .map((title, index) => ({ id: `s${index + 1}`, title, status: "pending" as const }));
}

function planningSystem(base: string | undefined): string {
  const prefix = base ? `${base}\n\n` : "";
  return `${prefix}First, break the task into a short ordered list of concrete steps. Output ONLY the steps, one per line, with no preamble. Do not execute anything yet.`;
}

function executionSystem(base: string | undefined, plan: PlanState): string {
  const prefix = base ? `${base}\n\n` : "";
  return `${prefix}Follow this plan, executing one step at a time with the available tools:\n${renderPlan(
    plan,
  )}\n\nCall tools to make progress. When every step is done, give a final summary without calling any tool.`;
}

async function planTurn(ctx: BrainContext, options: DeepBrainOptions): Promise<BrainAction> {
  const result = await ctx.infer({
    tier: options.planningTier ?? "strong",
    system: planningSystem(options.systemPrompt),
    messages: ctx.entries,
  });
  const steps = parsePlanSteps(result.text, options.maxSteps ?? 8);
  // A model that returned no parseable steps still gets a one-step plan so the
  // execution phase runs instead of stalling.
  const safeSteps: PlanStep[] =
    steps.length > 0 ? steps : [{ id: "s1", title: "complete the task", status: "pending" }];
  return { kind: "plan", plan: { revision: 1, steps: safeSteps } };
}

async function executeTurn(
  ctx: BrainContext,
  plan: PlanState,
  options: DeepBrainOptions,
): Promise<BrainAction> {
  const result = await ctx.infer({
    tier: options.executionTier ?? "fast",
    system: executionSystem(options.systemPrompt, plan),
    messages: ctx.entries,
    tools: ctx.capabilities.map((capability) => ({
      name: capability.name,
      description: capability.description,
      inputSchema: capability.inputSchema,
    })),
  });

  if (result.toolCalls && result.toolCalls.length > 0) {
    const position = ctx.entries.length;
    return {
      kind: "tool_call",
      ...(result.text ? { text: result.text } : {}),
      calls: result.toolCalls.map((call, index) => ({
        capability: call.name,
        args: call.args,
        idempotencyKey: `d${position}.${index}.${call.id}`,
      })),
    };
  }
  if (result.text) {
    return { kind: "respond", text: result.text };
  }
  return { kind: "finish", summary: "completed the plan" };
}

async function decide(ctx: BrainContext, options: DeepBrainOptions): Promise<BrainAction> {
  // A trailing assistant message means the previous decision was the final
  // answer; end the turn, mirroring the single-loop termination rule.
  if (ctx.entries.at(-1)?.kind === "assistant") {
    const last = ctx.entries.at(-1);
    return { kind: "finish", summary: last?.kind === "assistant" ? last.text : "done" };
  }
  if (!ctx.plan) {
    return planTurn(ctx, options);
  }
  return executeTurn(ctx, ctx.plan, options);
}

/** Creates the deep (plan-then-execute) brain. */
export function createDeepBrain(options: DeepBrainOptions = {}): AgentBrain {
  return {
    descriptor: {
      id: "deep",
      version: options.version ?? "1.0.0",
      displayName: "Deep",
      capabilitiesRequired: [],
    },
    nextAction: (ctx) => decide(ctx, options),
  };
}
