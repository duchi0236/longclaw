// In-memory session store for tests and ephemeral sessions.

import type { ConversationEntry, PlanState } from "../../brain-contract/src/index.js";
import type { PersistedSession, SessionStore } from "./store.js";

/** Volatile store; state lives as long as the process. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, PersistedSession>();

  load(sessionId: string): Promise<PersistedSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      entries: [...session.entries],
      ...(session.plan ? { plan: session.plan } : {}),
    });
  }

  appendEntries(sessionId: string, entries: ConversationEntry[]): Promise<void> {
    const session = this.sessions.get(sessionId) ?? { entries: [] };
    session.entries.push(...entries);
    this.sessions.set(sessionId, session);
    return Promise.resolve();
  }

  savePlan(sessionId: string, plan: PlanState): Promise<void> {
    const session = this.sessions.get(sessionId) ?? { entries: [] };
    session.plan = plan;
    this.sessions.set(sessionId, session);
    return Promise.resolve();
  }
}
