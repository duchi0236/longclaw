// Unified agent CLI: a runnable command-line agent. Reads config from flags
// and the model's API key from the env var the preset names, runs against a
// local sandbox confined to a workspace, and gates risky tool calls on a
// terminal prompt when the policy is "ask". One-shot with a trailing prompt,
// interactive REPL otherwise.
//
//   DEEPSEEK_API_KEY=... node_modules/.bin/tsx src/unified-agent/cli.ts \
//     --workspace ./work --policy ask
//
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeEvent, RuntimeEventSink } from "../../packages/loop-runtime/src/index.js";
import { LocalSandbox } from "../../packages/sandbox-core/src/index.js";
import { SqliteTelemetryStore } from "../../packages/telemetry-store/src/index.js";
import { parseCliArgs } from "./cli-args.js";
import { DEEPSEEK_MODEL, startAgent, type UnifiedAgent } from "./index.js";

const SYSTEM_PROMPT =
  "You are a coding assistant working in a sandboxed workspace. Use the " +
  "fs.read, fs.write, fs.list, and exec.run tools to inspect and change files " +
  "and run commands rather than only describing them. Be concise.";

function modeConfig(mode: "standard" | "deep" | "team") {
  return {
    id: mode,
    maxParallelToolCalls: 1,
    planningEnabled: mode === "deep",
  };
}

function printEvent(event: RuntimeEvent): void {
  // Subtask sessions are "<parent>:sub:<title>"; label their events so team
  // mode shows which delegated worker is acting.
  const subIndex = event.sessionId.indexOf(":sub:");
  const label = subIndex === -1 ? "" : `[${event.sessionId.slice(subIndex + 5)}] `;
  if (event.kind === "tool_call_finished") {
    const status = event.isError ? "error" : "ok";
    process.stdout.write(`  · ${label}${event.capability} → ${status}\n`);
  } else if (event.kind === "approval_resolved" && event.decision === "deny") {
    process.stdout.write(`  · ${label}${event.capability} denied\n`);
  } else if (event.kind === "sandbox_suspended") {
    process.stdout.write(`  · ${label}sandbox unavailable: ${event.detail}\n`);
  }
}

type Mode = ReturnType<typeof modeConfig>;

async function runTurn(
  agent: UnifiedAgent,
  sessionId: string,
  message: string,
  mode: Mode,
): Promise<void> {
  const result = await agent.runtime.runTurn({
    sessionId,
    userMessage: message,
    binding: { kind: "cloud-general" },
    mode,
  });
  for (const response of result.responses) {
    process.stdout.write(`\n${response}\n`);
  }
  if (result.status === "awaiting-user" && result.question) {
    process.stdout.write(`\n? ${result.question}\n`);
  } else if (result.status !== "finished") {
    process.stdout.write(`\n[${result.status}] ${result.detail ?? ""}\n`);
  }
}

async function repl(agent: UnifiedAgent, rl: Interface, mode: Mode): Promise<void> {
  process.stdout.write("unified agent ready. type a message, or 'exit' to quit.\n");
  for (;;) {
    const input = (await rl.question("\n> ")).trim();
    if (input === "") {
      continue;
    }
    if (input === "exit" || input === "quit") {
      break;
    }
    await runTurn(agent, "cli", input, mode);
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const workspaceRoot = path.resolve(options.workspace);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Telemetry is persisted only when a path is given; the same sink also prints
  // live progress, so tool-quality data accrues without changing the loop.
  let telemetryStore: SqliteTelemetryStore | undefined;
  const sinks: RuntimeEventSink[] = [printEvent];
  if (options.telemetryDb) {
    mkdirSync(path.dirname(path.resolve(options.telemetryDb)), { recursive: true });
    telemetryStore = new SqliteTelemetryStore(new DatabaseSync(options.telemetryDb));
    sinks.push(telemetryStore.asSink());
  }
  const telemetry: RuntimeEventSink = (event) => {
    for (const sink of sinks) {
      sink(event);
    }
  };

  const agent = startAgent(
    {
      model: DEEPSEEK_MODEL,
      mode: options.mode,
      policy: options.policy,
      systemPrompt: SYSTEM_PROMPT,
      ...(options.db ? { store: { kind: "sqlite", path: options.db } } : {}),
    },
    {
      sandboxProviders: [new LocalSandbox({ workspaceRoot })],
      telemetry,
      approvalGate: {
        decide: async (request) => {
          const answer = await rl.question(
            `\n⚠ allow ${request.capability} (${request.riskClass})? ` +
              `${JSON.stringify(request.args)} [y/N] `,
          );
          return answer.trim().toLowerCase().startsWith("y") ? "allow" : "deny";
        },
      },
    },
  );

  const mode = modeConfig(options.mode);
  process.stdout.write(
    `workspace: ${workspaceRoot}  ·  mode: ${options.mode}  ·  policy: ${options.policy}\n`,
  );
  try {
    if (options.prompt) {
      await runTurn(agent, "cli", options.prompt, mode);
    } else {
      await repl(agent, rl, mode);
    }
  } finally {
    agent.close();
    rl.close();
    if (telemetryStore) {
      printToolQuality(telemetryStore);
    }
  }
}

function printToolQuality(store: SqliteTelemetryStore): void {
  const ranking = store.toolQualityRanking();
  if (ranking.length === 0) {
    return;
  }
  process.stdout.write("\ntool quality:\n");
  for (const tool of ranking) {
    const err = `${Math.round(tool.errorRate * 100)}% err`;
    process.stdout.write(
      `  ${tool.capability}: ${tool.calls} calls · ${err} · ${Math.round(tool.avgDurationMs)}ms avg\n`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
