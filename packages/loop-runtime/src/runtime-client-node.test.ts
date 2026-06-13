// M1 milestone proof: the loop runs in the cloud while the sandbox lives on a
// paired device. The standard brain decides; the runtime routes every tool
// call down to a fake client node over the NodeInvoker port; results flow
// back and the conversation persists. Nothing here touches a real filesystem
// — the device does the work, the cloud only orchestrates.
import { describe, expect, it } from "vitest";
import { createStandardBrain } from "../../brain-standard/src/index.js";
import {
  ClientNodeSandbox,
  CORE_CAPABILITY_MANIFESTS,
  SandboxRouter,
  type NodeInvokeOutcome,
  type NodeInvokeRequest,
  type NodeInvoker,
  type NodeStatus,
} from "../../sandbox-core/src/index.js";
import { LoopRuntime } from "./runtime.js";

const STANDARD_MODE = { id: "standard", maxParallelToolCalls: 1, planningEnabled: false };

/** A paired device with an in-memory filesystem and scripted exec. */
class FakeDevice implements NodeInvoker {
  readonly files = new Map<string, string>();
  connected = true;

  status(_deviceId: string): Promise<NodeStatus> {
    return Promise.resolve({ connected: this.connected, primitives: ["fs", "proc"] });
  }

  invoke(request: NodeInvokeRequest): Promise<NodeInvokeOutcome> {
    if (!this.connected) {
      return Promise.resolve({ ok: false, code: "DISCONNECTED", message: "device offline" });
    }
    const p = (request.params ?? {}) as Record<string, unknown>;
    switch (request.command) {
      case "fs.write":
        this.files.set(String(p.path), String(p.content));
        return Promise.resolve({ ok: true, result: { ok: true } });
      case "fs.read": {
        const content = this.files.get(String(p.path));
        return Promise.resolve({
          ok: true,
          result: content === undefined ? { found: false } : { found: true, content },
        });
      }
      case "system.run":
        return Promise.resolve({
          ok: true,
          result: { success: true, exitCode: 0, stdout: `[device] ${String(p.rawCommand)}` },
        });
      default:
        return Promise.resolve({ ok: false, code: "UNAVAILABLE", message: "unknown" });
    }
  }
}

describe("cloud loop, device sandbox (M1)", () => {
  it("runs a tool-using turn entirely on the paired device", async () => {
    const device = new FakeDevice();
    const router = new SandboxRouter();
    router.register(new ClientNodeSandbox(device));

    // The model: first inspect the repo on the device, then write a fix, then
    // report — the classic agent loop, but hands are on the user's machine.
    const script = [
      {
        text: "",
        toolCalls: [{ id: "1", name: "fs.read", args: { path: "src/bug.ts" } }],
        tokensUsed: 5,
      },
      {
        text: "",
        toolCalls: [
          { id: "2", name: "fs.write", args: { path: "src/bug.ts", content: "fixed" } },
          { id: "3", name: "exec.run", args: { command: "npm test" } },
        ],
        tokensUsed: 5,
      },
      { text: "Patched src/bug.ts and tests pass on your machine.", tokensUsed: 5 },
    ];
    device.files.set("src/bug.ts", "buggy");
    let step = 0;

    const runtime = new LoopRuntime({
      brain: createStandardBrain(),
      manifests: CORE_CAPABILITY_MANIFESTS,
      router,
      inference: () => Promise.resolve(script[step++]!),
      approvalGate: { decide: () => Promise.resolve("allow") },
      policy: "auto",
    });

    const result = await runtime.runTurn({
      sessionId: "s1",
      userMessage: "fix the bug in src/bug.ts",
      binding: { kind: "client-node", deviceId: "macbook-1" },
      mode: STANDARD_MODE,
    });

    expect(result.status).toBe("finished");
    expect(result.summary).toBe("Patched src/bug.ts and tests pass on your machine.");
    // The write landed on the device's filesystem, not in the cloud.
    expect(device.files.get("src/bug.ts")).toBe("fixed");

    const entries = runtime.sessionEntries("s1");
    const toolResults = entries.filter((e) => e.kind === "tool_result");
    expect(toolResults).toHaveLength(3);
    expect(toolResults[2]).toMatchObject({ capability: "exec.run", output: "[device] npm test" });
  });

  it("suspends the session when the device drops mid-turn", async () => {
    const device = new FakeDevice();
    const router = new SandboxRouter();
    router.register(new ClientNodeSandbox(device));

    let step = 0;
    const script = [
      {
        text: "",
        toolCalls: [{ id: "1", name: "fs.read", args: { path: "x" } }],
        tokensUsed: 1,
      },
    ];

    const runtime = new LoopRuntime({
      brain: createStandardBrain(),
      manifests: CORE_CAPABILITY_MANIFESTS,
      router,
      inference: () => {
        // Device goes offline right before the tool call is dispatched.
        device.connected = false;
        return Promise.resolve(script[step++] ?? { text: "done", tokensUsed: 1 });
      },
      approvalGate: { decide: () => Promise.resolve("allow") },
      policy: "auto",
    });

    // Device must be online for ensureReady; it drops during the turn.
    const result = await runtime.runTurn({
      sessionId: "s1",
      userMessage: "read x",
      binding: { kind: "client-node", deviceId: "macbook-1" },
      mode: STANDARD_MODE,
    });

    // ensureReady ran while connected; the dropped invoke surfaces as a
    // transport failure that suspends rather than a fake command error.
    expect(result.status).toBe("suspended");
    expect(result.detail).toContain("DISCONNECTED");
  });
});
