// Gateway bridge: the single seam between the production gateway and the new
// unified-agent stack. On an inbound turn the gateway calls
// `runUnifiedAgentTurn`, which maps a GatewayTurnRequest to the runtime's
// TurnInput, drives the agent, and maps the TurnResult back. Wiring the
// gateway's real entry point to this seam is the unification step — there is
// one canonical path, no parallel engine switch.
//
// This module is deliberately isolated and dependency-light: all imports are
// type-only, and the real agent factory (`startAgent`, which pulls the LLM and
// store stack) is loaded lazily inside the default builder. That keeps the
// bridge importable and unit-testable with a fake agent, without dragging in
// providers or native deps.

import type { AcpSessionTransport } from "../../packages/brain-acp/src/index.js";
import type { ExecutionPolicy } from "../../packages/capability-contract/src/index.js";
import type {
  ApprovalGate,
  RuntimeEventSink,
  TurnInput,
  TurnResult,
  TurnStatus,
} from "../../packages/loop-runtime/src/index.js";
import type { SandboxBinding, SandboxProvider } from "../../packages/sandbox-core/src/index.js";
import type { AgentConfig, ModelConfig } from "./config.js";

/** One inbound turn the gateway hands to the unified stack. */
export interface GatewayTurnRequest {
  agentId: string;
  sessionId: string;
  userMessage: string;
  model: ModelConfig;
  mode?: AgentConfig["mode"];
  policy?: ExecutionPolicy;
  binding?: SandboxBinding;
  systemPrompt?: string;
  budget?: { tokens?: number; toolCalls?: number };
}

/** The reply the gateway gets back, mapped from a TurnResult. */
export interface GatewayTurnReply {
  status: TurnStatus;
  responses: string[];
  summary?: string;
  question?: string;
  detail?: string;
}

/** Minimal shape of a built agent the bridge drives. The real UnifiedAgent
 * satisfies this structurally; tests provide a fake. */
export interface UnifiedAgentLike {
  runtime: { runTurn(input: TurnInput): Promise<TurnResult> };
  close(): void;
}

/** Injected dependencies for the bridge. */
export interface GatewayBridgeDeps {
  /** A prebuilt agent to reuse across turns; the caller owns its lifecycle. */
  agent?: UnifiedAgentLike;
  /** Factory invoked per turn when no `agent` is given; defaults to startAgent. */
  buildAgent?: (config: AgentConfig) => UnifiedAgentLike | Promise<UnifiedAgentLike>;
  /** ACP transport, required when a turn runs in "acp" mode. */
  acpTransport?: AcpSessionTransport;
  /** Sandbox providers to register (e.g. a gateway-backed ClientNodeSandbox). */
  sandboxProviders?: SandboxProvider[];
  /** Approval gate wired to the gateway's human-in-the-loop UI. */
  approvalGate?: ApprovalGate;
  /** Telemetry sink forwarding runtime events to gateway UI/observability. */
  telemetry?: RuntimeEventSink;
}

/** Builds the loop ModeConfig the runtime expects from the mode label. */
function toModeConfig(mode: AgentConfig["mode"]): TurnInput["mode"] {
  const id = mode ?? "standard";
  return {
    id,
    maxParallelToolCalls: id === "team" ? 4 : 1,
    planningEnabled: id === "deep",
  };
}

/** Maps a gateway request to the runtime's TurnInput. */
function toTurnInput(req: GatewayTurnRequest): TurnInput {
  return {
    sessionId: req.sessionId,
    userMessage: req.userMessage,
    binding: req.binding ?? { kind: "cloud-general" },
    mode: toModeConfig(req.mode),
    ...(req.budget ? { budget: req.budget } : {}),
  };
}

/** Builds the declarative AgentConfig from a gateway request. */
function toAgentConfig(req: GatewayTurnRequest): AgentConfig {
  return {
    model: req.model,
    ...(req.mode ? { mode: req.mode } : {}),
    ...(req.policy ? { policy: req.policy } : {}),
    ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
  };
}

/** Maps a runtime TurnResult to the gateway reply shape. */
function toReply(result: TurnResult): GatewayTurnReply {
  return {
    status: result.status,
    responses: result.responses,
    ...(result.summary !== undefined ? { summary: result.summary } : {}),
    ...(result.question !== undefined ? { question: result.question } : {}),
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
  };
}

/** Default agent factory: lazily loads startAgent so importing this bridge
 * never pulls the provider/store stack (or its native deps). */
async function defaultBuildAgent(
  config: AgentConfig,
  deps: GatewayBridgeDeps,
): Promise<UnifiedAgentLike> {
  const { startAgent } = await import("./index.js");
  return startAgent(config, {
    ...(deps.acpTransport ? { acpTransport: deps.acpTransport } : {}),
    ...(deps.sandboxProviders ? { sandboxProviders: deps.sandboxProviders } : {}),
    ...(deps.approvalGate ? { approvalGate: deps.approvalGate } : {}),
    ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
  });
}

/**
 * Runs one inbound gateway turn on the unified stack and returns the reply.
 * A caller-provided `agent` is reused (and not closed); otherwise a fresh agent
 * is built for the turn and closed afterwards.
 */
export async function runUnifiedAgentTurn(
  req: GatewayTurnRequest,
  deps: GatewayBridgeDeps = {},
): Promise<GatewayTurnReply> {
  const owned = !deps.agent;
  const agent =
    deps.agent ??
    (deps.buildAgent
      ? await deps.buildAgent(toAgentConfig(req))
      : await defaultBuildAgent(toAgentConfig(req), deps));
  try {
    const result = await agent.runtime.runTurn(toTurnInput(req));
    return toReply(result);
  } finally {
    if (owned) {
      agent.close();
    }
  }
}
