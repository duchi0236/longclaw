// Phase 5 — shadow runner. Runs a turn on both engines (legacy + unified) but
// only the primary's reply ships; the shadow is compared, never sent. This is
// how the unified stack earns trust before flipping the default: run it in the
// dark, measure divergence, then promote. An engine here is any function that
// turns a request into a reply, so the gateway can pass its legacy path and the
// unified bridge without this module knowing either one's internals.

import type { GatewayTurnReply, GatewayTurnRequest } from "./gateway-bridge.js";

/** A turn engine: request in, reply out. */
export type TurnEngine = (req: GatewayTurnRequest) => Promise<GatewayTurnReply>;

/** Result of a shadow comparison; `primary` is what ships. */
export interface ShadowOutcome {
  primary: GatewayTurnReply;
  shadow: GatewayTurnReply;
  diverged: boolean;
  notes: string[];
}

/** Compares two replies and lists where they differ. */
function compareReplies(primary: GatewayTurnReply, shadow: GatewayTurnReply): string[] {
  const notes: string[] = [];
  if (primary.status !== shadow.status) {
    notes.push(`status: ${primary.status} vs ${shadow.status}`);
  }
  if (JSON.stringify(primary.responses) !== JSON.stringify(shadow.responses)) {
    notes.push(`responses differ (${primary.responses.length} vs ${shadow.responses.length})`);
  }
  return notes;
}

/**
 * Runs both engines for one request. The primary reply is returned for the
 * gateway to ship; the shadow reply is only compared. The shadow never throws
 * the turn — a shadow failure is recorded as divergence, not an error.
 */
export async function runShadowTurn(
  req: GatewayTurnRequest,
  primaryEngine: TurnEngine,
  shadowEngine: TurnEngine,
): Promise<ShadowOutcome> {
  const primary = await primaryEngine(req);
  let shadow: GatewayTurnReply;
  try {
    shadow = await shadowEngine(req);
  } catch (error) {
    return {
      primary,
      shadow: { status: "error", responses: [], detail: String(error) },
      diverged: true,
      notes: [`shadow threw: ${String(error)}`],
    };
  }
  const notes = compareReplies(primary, shadow);
  return { primary, shadow, diverged: notes.length > 0, notes };
}
