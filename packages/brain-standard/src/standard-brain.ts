// Standard brain v1: the existing OpenClaw single-loop behavior expressed
// behind the brain contract. The decision policy mirrors
// packages/agent-core/src/agent-loop.ts — one model call produces one
// assistant message (text plus tool calls); tool calls execute as a batch;
// the turn ends on the first assistant message without tool calls.
//
// The brain is stateless: every decision derives from the conversation
// entries alone, which is what makes it swappable mid-session and replayable
// in shadow evaluation.

import type {
  AgentBrain,
  BrainAction,
  BrainContext,
  InferenceToolDefinition,
} from "../../brain-contract/src/index.js";
import type { CapabilityManifest } from "../../capability-contract/src/index.js";

/** Build-time options for one standard brain version. */
export interface StandardBrainOptions {
  /** System prompt prepended to every inference; product-owned. */
  systemPrompt?: string;
  /** Model tier the runtime should route to. Standard mode defaults fast. */
  tier?: "fast" | "strong";
  /** Brain build version, bumped by the release pipeline. */
  version?: string;
}

/** Maps a capability manifest to the tool definition the model sees. */
export function capabilityToToolDefinition(manifest: CapabilityManifest): InferenceToolDefinition {
  return {
    name: manifest.name,
    description: manifest.description,
    inputSchema: manifest.inputSchema,
  };
}

async function decide(ctx: BrainContext, options: StandardBrainOptions): Promise<BrainAction> {
  const last = ctx.entries.at(-1);
  // Mirror of agent-loop.ts turn termination: an assistant message with no
  // tool calls ends the turn. That message is recorded in the entries, so
  // seeing it here means the previous decision was the final response.
  if (last?.kind === "assistant") {
    return { kind: "finish", summary: last.text };
  }

  const result = await ctx.infer({
    tier: options.tier ?? "fast",
    ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
    messages: ctx.entries,
    tools: ctx.capabilities.map(capabilityToToolDefinition),
  });

  if (result.toolCalls && result.toolCalls.length > 0) {
    // Position-prefixed keys stay unique across the session: entries only
    // grow, while model-assigned call ids are unique per response only.
    const position = ctx.entries.length;
    return {
      kind: "tool_call",
      ...(result.text ? { text: result.text } : {}),
      calls: result.toolCalls.map((call, index) => ({
        capability: call.name,
        args: call.args,
        idempotencyKey: `s${position}.${index}.${call.id}`,
      })),
    };
  }

  if (result.text) {
    return { kind: "respond", text: result.text };
  }
  // Model produced neither text nor tool calls; end the turn like the
  // existing loop does instead of spinning.
  return { kind: "finish", summary: "turn ended without model output" };
}

/** Creates the standard (single-loop) brain. */
export function createStandardBrain(options: StandardBrainOptions = {}): AgentBrain {
  return {
    descriptor: {
      id: "standard",
      version: options.version ?? "1.0.0",
      displayName: "Standard",
      capabilitiesRequired: [],
    },
    nextAction: (ctx) => decide(ctx, options),
  };
}
