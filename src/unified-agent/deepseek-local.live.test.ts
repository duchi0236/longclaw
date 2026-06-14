// Live end-to-end on real disk: the unified agent on DeepSeek, executing
// through LocalSandbox in a temp workspace. Proves the model's tool calls
// produce real files on the filesystem — the strongest "the agent actually
// does work" check. Gated on OPENCLAW_LIVE_TEST=1 and DEEPSEEK_API_KEY.
//   OPENCLAW_LIVE_TEST=1 DEEPSEEK_API_KEY=... pnpm test unified-agent
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalSandbox } from "../../packages/sandbox-core/src/index.js";
import { DEEPSEEK_MODEL, startAgent } from "./index.js";

const LIVE = process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(process.env.DEEPSEEK_API_KEY);
const describeLive = LIVE ? describe : describe.skip;

function readAllFiles(root: string): { name: string; content: string }[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      return { name: path.relative(root, full), content: readFileSync(full, "utf8") };
    });
}

describeLive("unified agent on DeepSeek with local sandbox", () => {
  it("produces a real file on disk via tool calls", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-live-"));
    const agent = startAgent(
      {
        model: DEEPSEEK_MODEL,
        policy: "auto",
        systemPrompt:
          "You operate a sandboxed workspace. Use the fs.write tool to create " +
          "files rather than describing them. Be concise.",
      },
      { sandboxProviders: [new LocalSandbox({ workspaceRoot: root })] },
    );

    try {
      const result = await agent.runtime.runTurn({
        sessionId: "live-local-1",
        userMessage:
          "Create a file in the workspace containing exactly the text 'hello world'. " +
          "Use the fs.write tool, then confirm.",
        binding: { kind: "cloud-general" },
        mode: { id: "standard", maxParallelToolCalls: 1, planningEnabled: false },
      });

      expect(result.status).toBe("finished");
      // The model's tool call left a real file on disk containing the text.
      const files = readAllFiles(root);
      expect(files.some((f) => f.content.includes("hello world"))).toBe(true);
    } finally {
      agent.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
