// Session store port: durable conversation state behind a narrow interface.
// The loop runtime is the only writer; entries are an append-only log from
// which the full session (history, plan, spent idempotency keys) rebuilds.

import type { ConversationEntry, PlanState } from "../../brain-contract/src/index.js";

/** Everything needed to resume a session after a restart. */
export interface PersistedSession {
  entries: ConversationEntry[];
  plan?: PlanState;
}

/**
 * Durable storage for session conversation state. Implementations must keep
 * entry order stable and `appendEntries` atomic per call — a half-written
 * batch would corrupt resume-time idempotency-key recovery.
 */
export interface SessionStore {
  /** Loads a session; null when the id has never been written. */
  load(sessionId: string): Promise<PersistedSession | null>;
  /** Appends entries at the end of the session's log, in order. */
  appendEntries(sessionId: string, entries: ConversationEntry[]): Promise<void>;
  /** Replaces the session's plan state. */
  savePlan(sessionId: string, plan: PlanState): Promise<void>;
}

/** One session's metadata for listing a user's conversations. */
export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
}

/**
 * A session store backed by central, shared storage (one online database many
 * runtime instances read/write). Adds tenancy: every session has an owner, so
 * any instance can serve any user's session and a user can list their own
 * conversations across devices. Centralizing the data is what makes the
 * conversation truly online and the runtime instances stateless.
 */
export interface CentralSessionStore extends SessionStore {
  /** Records the session's owner on first use; idempotent. */
  ensureSession(sessionId: string, ownerUserId: string): Promise<void>;
  /** Lists a user's sessions, most recently updated first. */
  listSessions(ownerUserId: string): Promise<SessionSummary[]>;
  /** Returns the owning user id, for access checks; null if unknown. */
  ownerOf(sessionId: string): Promise<string | null>;
}
