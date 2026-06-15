// OTLP exporter tests: a captured transport plus deterministic ids/clock let
// us assert the emitted OTLP payload — one trace per turn, child spans linked
// to the root, GenAI attributes, and error status mapping.
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../loop-runtime/src/index.js";
import { OtlpTraceExporter } from "./otlp-exporter.js";

interface CapturedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  status: { code: number };
}

function harness() {
  const posts: { url: string; spans: CapturedSpan[] }[] = [];
  let counter = 0;
  const exporter = new OtlpTraceExporter({
    endpoint: "http://localhost:6006/v1/traces",
    transport: (url, body) => {
      const payload = JSON.parse(body) as {
        resourceSpans: { scopeSpans: { spans: CapturedSpan[] }[] }[];
      };
      posts.push({ url, spans: payload.resourceSpans[0]!.scopeSpans[0]!.spans });
      return Promise.resolve();
    },
    now: () => 1000,
    randomId: (bytes) => String(++counter).padStart(bytes * 2, "0"),
  });
  return { sink: exporter.asSink(), posts };
}

function attr(span: CapturedSpan, key: string): Record<string, unknown> | undefined {
  return span.attributes.find((a) => a.key === key)?.value;
}

const turn: RuntimeEvent[] = [
  {
    kind: "turn_started",
    sessionId: "s1",
    brainId: "standard",
    brainVersion: "1.0.0",
    mode: "standard",
  },
  { kind: "inference_finished", sessionId: "s1", tier: "fast", tokensUsed: 10 },
  {
    kind: "approval_resolved",
    sessionId: "s1",
    capability: "exec.run",
    riskClass: "execute",
    decision: "user-allowed",
  },
  {
    kind: "tool_call_finished",
    sessionId: "s1",
    capability: "fs.write",
    isError: false,
    replayed: false,
    durationMs: 5,
  },
  {
    kind: "tool_call_finished",
    sessionId: "s1",
    capability: "exec.run",
    isError: true,
    replayed: false,
    durationMs: 100,
  },
  { kind: "turn_finished", sessionId: "s1", status: "finished", toolCalls: 2, tokensUsed: 20 },
];

describe("OtlpTraceExporter", () => {
  it("emits one trace per turn with child spans linked to the root", () => {
    const { sink, posts } = harness();
    for (const event of turn) {
      sink(event);
    }

    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("http://localhost:6006/v1/traces");
    const spans = posts[0]!.spans;
    expect(spans).toHaveLength(5);

    const root = spans.find((s) => s.name.startsWith("agent_turn"))!;
    const children = spans.filter((s) => s.parentSpanId === root.spanId);
    expect(children).toHaveLength(4);
    // Every span shares the turn's trace id.
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([root.traceId]));
  });

  it("tags the root with brain, mode, status, and token attributes", () => {
    const { sink, posts } = harness();
    for (const event of turn) {
      sink(event);
    }
    const root = posts[0]!.spans.find((s) => s.name.startsWith("agent_turn"))!;
    expect(attr(root, "openclaw.brain.id")).toEqual({ stringValue: "standard" });
    expect(attr(root, "openclaw.mode")).toEqual({ stringValue: "standard" });
    expect(attr(root, "openclaw.turn.status")).toEqual({ stringValue: "finished" });
    expect(attr(root, "openclaw.turn.tool_calls")).toEqual({ intValue: "2" });
    expect(attr(root, "gen_ai.usage.output_tokens")).toEqual({ intValue: "20" });
  });

  it("maps tool spans with GenAI tool name and error status", () => {
    const { sink, posts } = harness();
    for (const event of turn) {
      sink(event);
    }
    const spans = posts[0]!.spans;
    const ok = spans.find((s) => s.name === "execute_tool fs.write")!;
    const failed = spans.find((s) => s.name === "execute_tool exec.run")!;

    expect(attr(ok, "gen_ai.tool.name")).toEqual({ stringValue: "fs.write" });
    expect(ok.status.code).toBe(1);
    expect(attr(failed, "openclaw.tool.is_error")).toEqual({ boolValue: true });
    expect(failed.status.code).toBe(2);
  });

  it("ignores events with no open turn and isolates separate turns", () => {
    const { sink, posts } = harness();
    // A stray event before any turn_started is dropped.
    sink({
      kind: "tool_call_finished",
      sessionId: "s1",
      capability: "fs.read",
      isError: false,
      replayed: false,
      durationMs: 1,
    });
    expect(posts).toHaveLength(0);

    for (const event of turn) {
      sink(event);
    }
    const secondTurn: RuntimeEvent[] = turn.map((event) => {
      const copy = structuredClone(event);
      copy.sessionId = "s2";
      return copy;
    });
    for (const event of secondTurn) {
      sink(event);
    }
    expect(posts).toHaveLength(2);
    expect(posts[0]!.spans[0]!.traceId).not.toBe(posts[1]!.spans[0]!.traceId);
  });
});
