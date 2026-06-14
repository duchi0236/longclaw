// Live regression: the full unified agent against real DeepSeek. Gated on
// OPENCLAW_LIVE_TEST=1 and DEEPSEEK_API_KEY, so the default unit run skips it.
//   OPENCLAW_LIVE_TEST=1 DEEPSEEK_API_KEY=... pnpm test unified-agent
// Proves the production path — startAgent → real provider → tool orchestration
// → folded history → final answer — still works against a live model.
import { describe, expect, it } from "vitest";
import { MemorySandbox } from "../../packages/sandbox-core/src/index.js";
import { DEEPSEEK_MODEL, startAgent } from "./index.js";

const LIVE = process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(process.env.DEEPSEEK_API_KEY);
const describeLive = LIVE ? describe : describe.skip;

describeLive("unified agent on live DeepSeek", () => {
  it("completes a tool-orchestration turn end to end", async () => {
    const sandbox = new MemorySandbox({ execScript: (cmd) => ({ output: `ran: ${cmd}` }) });
    const agent = startAgent(
      {
        model: DEEPSEEK_MODEL,
        policy: "auto",
        systemPrompt:
          "You operate a sandboxed workspace. Use the fs.read, fs.write, and " +
          "fs.list tools to manipulate files rather than describing. Be concise.",
      },
      { sandboxProviders: [sandbox] },
    );

    try {
      const result = await agent.runtime.runTurn({
        sessionId: "live-1",
        userMessage: "Write 'hello world' to greeting.txt, then read it back to confirm.",
        binding: { kind: "cloud-general" },
        mode: { id: "standard", maxParallelToolCalls: 1, planningEnabled: false },
      });

      expect(result.status).toBe("finished");
      expect(result.summary && result.summary.length).toBeTruthy();
    } finally {
      agent.close();
    }
  }, 60_000);
});
