// ACP session transport: the narrow port the ACP brain depends on. It hides
// the whole ACP/JSON-RPC/stdio machinery behind two driveable calls, so the
// brain stays pure decision logic and tests can inject a scripted fake. A
// production implementation wraps `acpx` + `@agentclientprotocol/claude-agent-acp`,
// keeps one ACP session per OpenClaw session id, and is the single place that
// maps ACP file/terminal operations to OpenClaw capability names.

/** The agent (e.g. Claude Code) wants OpenClaw to run one capability. The
 * transport has already translated the ACP tool/file/terminal request into an
 * OpenClaw capability name and args. */
export interface AcpToolRequest {
  kind: "tool_request";
  /** ACP-assigned call id, unique within the session; used to correlate the
   * result fed back over ACP. */
  callId: string;
  /** OpenClaw capability the agent wants executed, e.g. "fs.write". */
  capability: string;
  args: unknown;
}

/** The agent finished this prompt turn with a final assistant message. */
export interface AcpFinal {
  kind: "final";
  text: string;
}

/** One discrete step the agent takes after a prompt or a fed-back result:
 * either it asks for a tool, or it finishes the turn. Streaming deltas are
 * coalesced inside the transport. */
export type AcpStep = AcpToolRequest | AcpFinal;

/** Result of a capability execution, handed back to the agent over ACP. */
export interface AcpToolResult {
  isError: boolean;
  output: string;
}

/** Stateful conversation with an ACP agent, keyed by OpenClaw session id. */
export interface AcpSessionTransport {
  /** Sends a user prompt to the session (creating the ACP session on first
   * use for this id) and returns the agent's first step. */
  prompt(sessionId: string, userText: string): Promise<AcpStep>;
  /** Feeds a tool result back to the pending ACP tool request identified by
   * `callId` and returns the agent's next step. */
  provideToolResult(
    sessionId: string,
    callId: string,
    result: AcpToolResult,
  ): Promise<AcpStep>;
}
