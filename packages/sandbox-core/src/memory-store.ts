// Memory store: the persistence backend behind the `memory.*` capability
// family. It is a narrow port so the sandbox stays free of any concrete store;
// the InMemoryMemoryStore below is the zero-dependency default for local and
// test use. Production wiring should inject a durable store (e.g. backed by the
// session-store / libSQL stack) that satisfies the same interface.

/** One stored memory note. */
export interface MemoryEntry {
  key: string;
  text: string;
  tags: string[];
  createdAt: number;
}

/** Arguments accepted by a memory write. */
export interface MemoryWriteInput {
  /** Stable key to upsert under. When omitted the store assigns one. */
  key?: string;
  text: string;
  tags?: string[];
}

/** Persistence port for the `memory.*` capabilities. Implementations must be
 * safe to call concurrently. */
export interface MemoryStore {
  /** Creates or overwrites an entry; returns the stored entry. */
  write(input: MemoryWriteInput): Promise<MemoryEntry>;
  /** Returns the entry for a key, or null when it does not exist. */
  read(key: string): Promise<MemoryEntry | null>;
  /** Returns entries matching a query, best match first, capped at limit. */
  search(query: string, options: { limit: number }): Promise<MemoryEntry[]>;
}

/** Renders matched memory entries into a compact text block for the brain.
 * Shared by every sandbox provider so `memory.search` output is identical
 * whether it ran locally, in the test twin, or on a paired device. */
export function formatMemoryEntries(entries: MemoryEntry[]): string {
  if (entries.length === 0) {
    return "no matches";
  }
  return entries
    .map((entry, index) => {
      const firstLine = entry.text.split("\n", 1)[0] ?? "";
      const tags = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
      return `${index + 1}. ${entry.key}: ${firstLine}${tags}`;
    })
    .join("\n");
}

/** Splits a query into lowercased word tokens for substring scoring. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 0);
}

/**
 * Default in-process memory store: a Map with deterministic key assignment and
 * a simple token-overlap ranking. Good enough for local dev, tests, and shadow
 * evaluation; not durable across process restarts.
 */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private nextId = 1;

  write(input: MemoryWriteInput): Promise<MemoryEntry> {
    const key = input.key && input.key.length > 0 ? input.key : `mem-${this.nextId++}`;
    const entry: MemoryEntry = {
      key,
      text: input.text,
      tags: input.tags ? [...input.tags] : [],
      createdAt: Date.now(),
    };
    this.entries.set(key, entry);
    return Promise.resolve(entry);
  }

  read(key: string): Promise<MemoryEntry | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  search(query: string, options: { limit: number }): Promise<MemoryEntry[]> {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return Promise.resolve([]);
    }
    const scored = [...this.entries.values()]
      .map((entry) => {
        const haystack = `${entry.text} ${entry.tags.join(" ")}`.toLowerCase();
        const score = tokens.reduce((sum, token) => (haystack.includes(token) ? sum + 1 : sum), 0);
        return { entry, score };
      })
      .filter((scored) => scored.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.createdAt - b.entry.createdAt)
      .slice(0, options.limit)
      .map((scored) => scored.entry);
    return Promise.resolve(scored);
  }
}
