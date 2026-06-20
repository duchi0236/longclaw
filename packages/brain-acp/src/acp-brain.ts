// ACP brain: a decision module that delegates each turn to an external agent
// harness (e.g. Claude Code) over the ACP transport, while OpenClaw keeps the
// tools, sandbox, approval, memory, and channels. It is NOT a model brain — it
// never calls the inference port. Instead it translates the agent's ACP steps
// into BrainActions the loop runtime already knows how to run.
//
// The mapping it enforces (so the "brain / tool separation" holds):
//   agent asks for a tool  ->  BrainAction tool_call  ->  runtime runs it in
//                              the sandbox, behind the approval gate
//   tool result            ->  fed back to the agent over ACP
//   agent's final message  ->  BrainAction respond, then finish
//
// Statelessness: every decision is derived from `ctx.entries` alone. The only
// external state is the ACP session itself, owned by the injected transport
// and keyed by session id — exactly like sandbox state lives behind the router.

import type {
  AgentBrain,
  BrainAction,
  BrainContext,
  ConversationEntry,
} from "../../brain-contract/src/index.js";
import type { AcpSessionTransport, AcpStep } from "./acp-transport.js";

/** Prefix that carries the ACP call id through the runtime's idempotency key,
 * so the result can be correlated and fed back over ACP — recovered from the
 * conversation entries, keeping the brain stateless. */
const ACP_KEY_PREFIX = "acp:";

/** Build-time options for one ACP brain. */
export interface AcpBrainOptions {
  /** The ACP session transport (production wraps acpx; tests inject a fake). */
  transport: AcpSessionTransport;
  /** Brain build version. */
  version?: string;
  /** Capability patterns the harness needs; the runtime refuses to load the
   * brain if the sandbox snapshot can't satisfy them. Defaults to none. */
  capabilitiesRequired?: string[];
  /** Display name surfaced in product UIs. */
  displayName?: string;
}

/** Wraps an ACP call id into the runtime idempotency key. */
function toIdempotencyKey(acpCallId: string): string {
  return `${ACP_KEY_PREFIX}${acpCallId}`;
}

/** Recovers the ACP call id stored on the tool_call entry with `callId`. */
function acpCallIdFor(
  entries: readonly ConversationEntry[],
  callId: string,
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.kind === "tool_call" && entry.callId === callId) {
      return entry.idempotencyKey.startsWith(ACP_KEY_PREFIX)
        ? entry.idempotencyKey.slice(ACP_KEY_PREFIX.length)
        : entry.idempotencyKey;
    }
  }
  return undefined;
}

/** Translates one ACP step into the action the runtime should take. */
function stepToAction(step: AcpStep): BrainAction {
  if (step.kind === "tool_request") {
    return {
      kind: "tool_call",
      calls: [
        {
          capability: step.capability,
          args: step.args,
          idempotencyKey: toIdempotencyKey(step.callId),
        },
      ],
    };
  }
  return { kind: "respond", text: step.text };
}

async function decide(
  ctx: BrainContext,
  transport: AcpSessionTransport,
): Promise<BrainAction> {
  const entries = ctx.entries;

  // Turn boundary: everything after the last user message belongs to this turn.
  let startIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.kind === "user") {
      startIdx = i;
      break;
    }
  }
  const turnTail = startIdx >= 0 ? entries.slice(startIdx + 1) : entries;

  // Brand-new turn: hand the user prompt to the agent and surface its first step.
  if (turnTail.length === 0) {
    const userText = startIdx >= 0 ? userTextAt(entries, startIdx) : "";
    return stepToAction(await transport.prompt(ctx.sessionId, userText));
  }

  const last = entries.at(-1);

  // The agent's final message was recorded last step → end the turn (mirrors
  // the standard brain's "assistant entry ⇒ finish" termination).
  if (last?.kind === "assistant") {
    return { kind: "finish", summary: last.text };
  }

  // A tool just ran (success or sandbox error): feed its result back to the
  // agent over ACP so it can continue, then surface the next step.
  if (last?.kind === "tool_result") {
    const acpCallId = acpCallIdFor(entries, last.callId) ?? last.callId;
    const step = await transport.provideToolResult(ctx.sessionId, acpCallId, {
      isError: last.isError,
      output: last.output,
    });
    return stepToAction(step);
  }

  // Defensive fallback (e.g. an unexpected system note with no pending tool):
  // end the turn rather than spin.
  return { kind: "finish", summary: "" };
}

/** Reads the text of the user entry at `index`. */
function userTextAt(entries: readonly ConversationEntry[], index: number): string {
  const entry = entries[index];
  return entry?.kind === "user" ? entry.text : "";
}

/** Creates a brain that drives an external ACP agent harness (Claude Code). */
export function createAcpBrain(options: AcpBrainOptions): AgentBrain {
  const { transport } = options;
  return {
    descriptor: {
      id: "acp",
      version: options.version ?? "0.1.0",
      displayName: options.displayName ?? "ACP Harness",
      capabilitiesRequired: options.capabilitiesRequired ?? [],
    },
    nextAction: (ctx) => decide(ctx, transport),
  };
}
