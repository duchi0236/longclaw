// CLI argument parsing for the unified agent, kept separate from the IO entry
// point so it can be tested in isolation. Flags configure the workspace,
// persistence, and execution policy; a trailing positional argument runs a
// single turn instead of an interactive session.

import type { ExecutionPolicy } from "../../packages/capability-contract/src/index.js";

/** Parsed CLI options. */
export interface CliOptions {
  /** Workspace root for the local sandbox. */
  workspace: string;
  /** SQLite session DB path; undefined means in-memory (no persistence). */
  db?: string;
  /** Execution policy for tool calls. */
  policy: ExecutionPolicy;
  /** One-shot prompt; when set, run a single turn and exit. */
  prompt?: string;
}

const POLICIES = new Set<ExecutionPolicy>(["read-only", "ask", "auto"]);

function isPolicy(value: string): value is ExecutionPolicy {
  return POLICIES.has(value as ExecutionPolicy);
}

/** Parses argv (without node/script prefix) into CLI options. Unknown flags
 * throw so typos fail loudly rather than being silently ignored. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  let workspace = "./agent-workspace";
  let db: string | undefined;
  let policy: ExecutionPolicy = "ask";
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--workspace":
      case "--db": {
        const value = argv[++i];
        if (value === undefined) {
          throw new Error(`${arg} requires a value`);
        }
        if (arg === "--workspace") {
          workspace = value;
        } else {
          db = value;
        }
        break;
      }
      case "--policy": {
        const value = argv[++i];
        if (value === undefined || !isPolicy(value)) {
          throw new Error("--policy must be one of read-only|ask|auto");
        }
        policy = value;
        break;
      }
      case "--auto":
        policy = "auto";
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`unknown flag: ${arg}`);
        }
        positionals.push(arg);
    }
  }

  return {
    workspace,
    ...(db !== undefined ? { db } : {}),
    policy,
    ...(positionals.length > 0 ? { prompt: positionals.join(" ") } : {}),
  };
}
