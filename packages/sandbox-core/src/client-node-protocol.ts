// Client-node protocol: the translation between core capabilities and the
// node command families a paired device implements. This is the contract our
// CLI/device node must satisfy. exec.run reuses the gateway's existing
// "system.run"; the fs.* family extends the node protocol with file commands.

import type { CapabilityResult } from "./provider.js";

/** A node command name plus its params, ready for NodeInvoker.invoke. */
export interface NodeCommand {
  command: string;
  params: unknown;
  /** Per-call timeout to forward to the node, when the capability sets one. */
  timeoutMs?: number;
}

/** Shell the node uses to run an exec.run command string as argv. The node
 * executes argv directly; keeping the choice here, not in the sandbox core,
 * documents the one place a shell is assumed. */
const EXEC_SHELL = ["bash", "-lc"] as const;

/** node "system.run" response shape (subset of the gateway's RunResult). */
interface SystemRunResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  success?: boolean;
  timedOut?: boolean;
  error?: string | null;
}

/** node "fs.read" response: content plus a found flag. */
interface FsReadResult {
  found?: boolean;
  content?: string;
}

/** node "fs.list" response: matching paths. */
interface FsListResult {
  names?: string[];
}

/** node "web.fetch" response: body plus status and truncation flag. */
interface WebFetchResult {
  ok?: boolean;
  status?: number;
  body?: string;
  truncated?: boolean;
  error?: string | null;
}

/** node "web.search" response: ranked results plus an optional error. */
interface WebSearchResult {
  results?: { title?: string; url?: string; snippet?: string }[];
  error?: string | null;
}

/** node "memory.write" response: the stored key. */
interface MemoryWriteResult {
  key?: string;
  error?: string | null;
}

/** node "memory.read" response: the note text plus a found flag. */
interface MemoryReadResult {
  found?: boolean;
  text?: string;
}

/** node "memory.search" response: matched entries. */
interface MemorySearchResult {
  results?: { key?: string; text?: string; tags?: string[] }[];
  error?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Translates a capability invocation into the node command to dispatch.
 * Throws on an unknown capability so a misrouted call fails loudly rather
 * than silently doing nothing on the device.
 */
export function capabilityToNodeCommand(capability: string, args: unknown): NodeCommand {
  const a = asRecord(args);
  switch (capability) {
    case "exec.run": {
      const command = String(a.command ?? "");
      const timeoutMs = typeof a.timeoutMs === "number" ? a.timeoutMs : undefined;
      return {
        command: "system.run",
        params: {
          command: [...EXEC_SHELL, command],
          rawCommand: command,
          cwd: a.cwd ?? null,
          timeoutMs: timeoutMs ?? null,
        },
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "fs.read":
      return { command: "fs.read", params: { path: String(a.path ?? "") } };
    case "fs.write":
      return {
        command: "fs.write",
        params: { path: String(a.path ?? ""), content: String(a.content ?? "") },
      };
    case "fs.list":
      return { command: "fs.list", params: { prefix: String(a.prefix ?? "") } };
    case "web.fetch": {
      const timeoutMs = typeof a.timeoutMs === "number" ? a.timeoutMs : undefined;
      return {
        command: "web.fetch",
        params: {
          url: String(a.url ?? ""),
          headers: a.headers ?? null,
          maxBytes: typeof a.maxBytes === "number" ? a.maxBytes : null,
          timeoutMs: timeoutMs ?? null,
        },
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "web.search": {
      const limit = typeof a.limit === "number" ? a.limit : undefined;
      return {
        command: "web.search",
        params: { query: String(a.query ?? ""), limit: limit ?? null },
      };
    }
    case "memory.write":
      return {
        command: "memory.write",
        params: {
          key: typeof a.key === "string" ? a.key : null,
          text: String(a.text ?? ""),
          tags: Array.isArray(a.tags) ? a.tags : null,
        },
      };
    case "memory.read":
      return { command: "memory.read", params: { key: String(a.key ?? "") } };
    case "memory.search": {
      const limit = typeof a.limit === "number" ? a.limit : undefined;
      return {
        command: "memory.search",
        params: { query: String(a.query ?? ""), limit: limit ?? null },
      };
    }
    default:
      throw new Error(`no client-node mapping for capability "${capability}"`);
  }
}

/**
 * Parses a node command result back into a capability result. A command that
 * ran but failed (non-zero exit, missing file) is a normal `isError` result,
 * not a transport failure.
 */
export function nodeResultToCapability(capability: string, result: unknown): CapabilityResult {
  switch (capability) {
    case "exec.run": {
      const run = result as SystemRunResult;
      const ok = run.success ?? (run.exitCode === 0 && !run.timedOut);
      const stdout = run.stdout ?? "";
      if (ok) {
        return { isError: false, output: stdout, details: run };
      }
      const reason = run.timedOut ? "timed out" : (run.error ?? `exit ${run.exitCode ?? "?"}`);
      const stderr = run.stderr ? `\n${run.stderr}` : "";
      return { isError: true, output: `${stdout}${stderr}\n[${reason}]`.trim(), details: run };
    }
    case "fs.read": {
      const read = result as FsReadResult;
      if (read.found === false || read.content === undefined) {
        return { isError: true, output: "file not found" };
      }
      return { isError: false, output: read.content };
    }
    case "fs.write":
      return { isError: false, output: "ok" };
    case "fs.list": {
      const list = result as FsListResult;
      return { isError: false, output: (list.names ?? []).join("\n") };
    }
    case "web.fetch": {
      const res = result as WebFetchResult;
      const ok =
        res.ok ?? (typeof res.status === "number" && res.status >= 200 && res.status < 300);
      const body = res.body ?? "";
      if (!ok) {
        return {
          isError: true,
          output: (res.error ?? `http ${res.status ?? "?"}`).trim(),
          details: res,
        };
      }
      return {
        isError: false,
        output: res.truncated ? `${body}\n[output truncated]` : body,
        details: res,
      };
    }
    case "web.search": {
      const res = result as WebSearchResult;
      if (res.error) {
        return { isError: true, output: res.error, details: res };
      }
      const results = res.results ?? [];
      const output =
        results.length === 0
          ? "no results"
          : results
              .map((entry, index) => {
                const head = `${index + 1}. ${entry.title ?? ""} — ${entry.url ?? ""}`;
                return entry.snippet ? `${head}\n   ${entry.snippet}` : head;
              })
              .join("\n");
      return { isError: false, output, details: res };
    }
    case "memory.write": {
      const res = result as MemoryWriteResult;
      if (res.error || !res.key) {
        return { isError: true, output: res.error ?? "memory.write failed", details: res };
      }
      return { isError: false, output: `stored: ${res.key}`, details: res };
    }
    case "memory.read": {
      const res = result as MemoryReadResult;
      if (res.found === false || res.text === undefined) {
        return { isError: true, output: "memory not found" };
      }
      return { isError: false, output: res.text };
    }
    case "memory.search": {
      const res = result as MemorySearchResult;
      if (res.error) {
        return { isError: true, output: res.error, details: res };
      }
      const results = res.results ?? [];
      const output =
        results.length === 0
          ? "no matches"
          : results
              .map((entry, index) => {
                const firstLine = (entry.text ?? "").split("\n", 1)[0] ?? "";
                const tags = entry.tags && entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
                return `${index + 1}. ${entry.key ?? ""}: ${firstLine}${tags}`;
              })
              .join("\n");
      return { isError: false, output, details: res };
    }
    default:
      return { isError: true, output: `unexpected client-node result for "${capability}"` };
  }
}
