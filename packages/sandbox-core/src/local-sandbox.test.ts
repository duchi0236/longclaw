// LocalSandbox tests run against a real temp workspace: fs round-trips, path
// confinement, real command execution with exit/timeout/truncation handling,
// and idempotency replay.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSandbox } from "./local-sandbox.js";
import type { CapabilityInvocation } from "./provider.js";

const roots: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "local-sandbox-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function call(capability: string, args: unknown, key: string): CapabilityInvocation {
  return { callId: `c-${key}`, capability, args, idempotencyKey: key };
}

async function ready(options?: Partial<{ execTimeoutMs: number; maxOutputBytes: number }>) {
  const root = workspace();
  const sandbox = new LocalSandbox({ workspaceRoot: root, ...options });
  const handle = await sandbox.ensureReady({ kind: "cloud-general" });
  return { root, sandbox, handle };
}

describe("LocalSandbox filesystem", () => {
  it("writes and reads files on disk, creating parent directories", async () => {
    const { root, sandbox, handle } = await ready();

    const write = await sandbox.invoke(
      handle,
      call("fs.write", { path: "src/app.ts", content: "export const x = 1;" }, "k1"),
    );
    expect(write.isError).toBe(false);
    expect(readFileSync(path.join(root, "src/app.ts"), "utf8")).toBe("export const x = 1;");

    const read = await sandbox.invoke(handle, call("fs.read", { path: "src/app.ts" }, "k2"));
    expect(read.output).toBe("export const x = 1;");

    const list = await sandbox.invoke(handle, call("fs.list", { prefix: "src/" }, "k3"));
    expect(list.output).toBe("src/app.ts");
  });

  it("confines reads and writes to the workspace root", async () => {
    const { sandbox, handle } = await ready();
    const escaped = await sandbox.invoke(
      handle,
      call("fs.read", { path: "../../etc/passwd" }, "k1"),
    );
    expect(escaped.isError).toBe(true);
    expect(escaped.output).toContain("escapes workspace");

    const escapedWrite = await sandbox.invoke(
      handle,
      call("fs.write", { path: "../evil.txt", content: "x" }, "k2"),
    );
    expect(escapedWrite.isError).toBe(true);
  });

  it("reports a missing file as an error result", async () => {
    const { sandbox, handle } = await ready();
    const read = await sandbox.invoke(handle, call("fs.read", { path: "nope.txt" }, "k1"));
    expect(read.isError).toBe(true);
    expect(read.output).toContain("not found");
  });
});

describe("LocalSandbox command execution", () => {
  it("runs a real command in the workspace and captures output", async () => {
    const { sandbox, handle } = await ready();
    await sandbox.invoke(handle, call("fs.write", { path: "hi.txt", content: "hello" }, "w1"));

    const exec = await sandbox.invoke(handle, call("exec.run", { command: "cat hi.txt" }, "e1"));
    expect(exec.isError).toBe(false);
    expect(exec.output).toContain("hello");
  });

  it("marks a non-zero exit as an error", async () => {
    const { sandbox, handle } = await ready();
    const exec = await sandbox.invoke(handle, call("exec.run", { command: "exit 3" }, "e1"));
    expect(exec.isError).toBe(true);
    expect(exec.output).toContain("exit 3");
  });

  it("kills and flags a command that exceeds its timeout", async () => {
    const { sandbox, handle } = await ready();
    const exec = await sandbox.invoke(
      handle,
      call("exec.run", { command: "sleep 5", timeoutMs: 200 }, "e1"),
    );
    expect(exec.isError).toBe(true);
    expect(exec.output).toContain("timed out");
  });

  it("truncates output beyond the byte cap", async () => {
    const { sandbox, handle } = await ready({ maxOutputBytes: 64 });
    const exec = await sandbox.invoke(
      handle,
      call("exec.run", { command: "for i in $(seq 1 1000); do echo line$i; done" }, "e1"),
    );
    expect(exec.output).toContain("[output truncated]");
  });
});

describe("LocalSandbox idempotency", () => {
  it("replays a cached result without re-running the command", async () => {
    const { root, sandbox, handle } = await ready();
    const cmd = call("exec.run", { command: "echo $RANDOM >> counter.txt" }, "once");

    const first = await sandbox.invoke(handle, cmd);
    const second = await sandbox.invoke(handle, cmd);

    expect(second.replayed).toBe(true);
    expect(second.output).toBe(first.output);
    // The append ran exactly once despite two invokes with the same key.
    expect(readFileSync(path.join(root, "counter.txt"), "utf8").trim().split("\n")).toHaveLength(1);
  });
});
