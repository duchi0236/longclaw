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
    default:
      return { isError: true, output: `unexpected client-node result for "${capability}"` };
  }
}
