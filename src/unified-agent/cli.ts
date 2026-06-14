// Unified agent CLI: a runnable command-line agent. Reads config from flags
// and the model's API key from the env var the preset names, runs against a
// local sandbox confined to a workspace, and gates risky tool calls on a
// terminal prompt when the policy is "ask". One-shot with a trailing prompt,
// interactive REPL otherwise.
//
//   DEEPSEEK_API_KEY=... node_modules/.bin/tsx src/unified-agent/cli.ts \
//     --workspace ./work --policy ask
//
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import type { RuntimeEvent } from "../../packages/loop-runtime/src/index.js";
import { LocalSandbox } from "../../packages/sandbox-core/src/index.js";
import { parseCliArgs } from "./cli-args.js";
import { DEEPSEEK_MODEL, startAgent, type UnifiedAgent } from "./index.js";

const SYSTEM_PROMPT =
  "You are a coding assistant working in a sandboxed workspace. Use the " +
  "fs.read, fs.write, fs.list, and exec.run tools to inspect and change files " +
  "and run commands rather than only describing them. Be concise.";

const MODE = { id: "standard", maxParallelToolCalls: 1, planningEnabled: false };

function printEvent(event: RuntimeEvent): void {
  if (event.kind === "tool_call_finished") {
    const status = event.isError ? "error" : "ok";
    process.stdout.write(`  · ${event.capability} → ${status}\n`);
  } else if (event.kind === "approval_resolved" && event.decision === "deny") {
    process.stdout.write(`  · ${event.capability} denied\n`);
  } else if (event.kind === "sandbox_suspended") {
    process.stdout.write(`  · sandbox unavailable: ${event.detail}\n`);
  }
}

async function runTurn(agent: UnifiedAgent, sessionId: string, message: string): Promise<void> {
  const result = await agent.runtime.runTurn({
    sessionId,
    userMessage: message,
    binding: { kind: "cloud-general" },
    mode: MODE,
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

async function repl(agent: UnifiedAgent, rl: Interface): Promise<void> {
  process.stdout.write("unified agent ready. type a message, or 'exit' to quit.\n");
  for (;;) {
    const input = (await rl.question("\n> ")).trim();
    if (input === "") {
      continue;
    }
    if (input === "exit" || input === "quit") {
      break;
    }
    await runTurn(agent, "cli", input);
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const workspaceRoot = path.resolve(options.workspace);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const agent = startAgent(
    {
      model: DEEPSEEK_MODEL,
      policy: options.policy,
      systemPrompt: SYSTEM_PROMPT,
      ...(options.db ? { store: { kind: "sqlite", path: options.db } } : {}),
    },
    {
      sandboxProviders: [new LocalSandbox({ workspaceRoot })],
      telemetry: printEvent,
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

  process.stdout.write(`workspace: ${workspaceRoot}  ·  policy: ${options.policy}\n`);
  try {
    if (options.prompt) {
      await runTurn(agent, "cli", options.prompt);
    } else {
      await repl(agent, rl);
    }
  } finally {
    agent.close();
    rl.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
