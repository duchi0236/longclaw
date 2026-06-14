// CLI argument parsing tests: defaults, flag handling, policy validation,
// one-shot prompt detection, and loud failure on bad input.
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli-args.js";

describe("parseCliArgs", () => {
  it("applies defaults with no arguments", () => {
    expect(parseCliArgs([])).toEqual({ workspace: "./agent-workspace", policy: "ask" });
  });

  it("parses workspace, db, and policy flags", () => {
    expect(
      parseCliArgs(["--workspace", "/tmp/w", "--db", "/tmp/a.sqlite", "--policy", "auto"]),
    ).toEqual({ workspace: "/tmp/w", db: "/tmp/a.sqlite", policy: "auto" });
  });

  it("treats --auto as a shorthand for the auto policy", () => {
    expect(parseCliArgs(["--auto"]).policy).toBe("auto");
  });

  it("collects a trailing prompt into a one-shot message", () => {
    expect(parseCliArgs(["--policy", "auto", "fix", "the", "bug"])).toMatchObject({
      policy: "auto",
      prompt: "fix the bug",
    });
  });

  it("rejects unknown flags and bad policies", () => {
    expect(() => parseCliArgs(["--nope"])).toThrow(/unknown flag/);
    expect(() => parseCliArgs(["--policy", "yolo"])).toThrow(/policy/);
    expect(() => parseCliArgs(["--workspace"])).toThrow(/requires a value/);
  });
});
