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
  /** SQLite telemetry DB path; undefined disables telemetry persistence. */
  telemetryDb?: string;
  /** OTLP/HTTP traces endpoint; undefined disables trace export. */
  otlpEndpoint?: string;
  /** Execution policy for tool calls. */
  policy: ExecutionPolicy;
  /** Agent mode: which brain drives the loop. */
  mode: "standard" | "deep" | "team";
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
  let telemetryDb: string | undefined;
  let otlpEndpoint: string | undefined;
  let policy: ExecutionPolicy = "ask";
  let mode: "standard" | "deep" | "team" = "standard";
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--workspace":
      case "--db":
      case "--telemetry-db":
      case "--otlp-endpoint": {
        const value = argv[++i];
        if (value === undefined) {
          throw new Error(`${arg} requires a value`);
        }
        if (arg === "--workspace") {
          workspace = value;
        } else if (arg === "--db") {
          db = value;
        } else if (arg === "--telemetry-db") {
          telemetryDb = value;
        } else {
          otlpEndpoint = value;
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
      case "--mode": {
        const value = argv[++i];
        if (value !== "standard" && value !== "deep" && value !== "team") {
          throw new Error("--mode must be standard, deep, or team");
        }
        mode = value;
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
    ...(telemetryDb !== undefined ? { telemetryDb } : {}),
    ...(otlpEndpoint !== undefined ? { otlpEndpoint } : {}),
    policy,
    mode,
    ...(positionals.length > 0 ? { prompt: positionals.join(" ") } : {}),
  };
}
