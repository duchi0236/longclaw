// OTLP trace exporter: assembles the runtime's event stream into OpenTelemetry
// traces and ships them to any OTLP/HTTP endpoint. One turn becomes one trace
// (a root span) with tool calls, inferences, and approvals as child spans,
// tagged with GenAI semantic-convention attributes. The agent only emits
// standard OTLP — visualization and analysis live in a separate, mature tool
// (Arize Phoenix, Langfuse, …) that runs independently of this project.

import { randomBytes } from "node:crypto";
import type { RuntimeEvent, RuntimeEventSink } from "../../loop-runtime/src/index.js";

/** Wire transport for OTLP payloads; defaults to fetch. Injectable for tests. */
export type OtlpTransport = (url: string, jsonBody: string) => Promise<void>;

/** Options for the exporter. */
export interface OtlpExporterOptions {
  /** OTLP/HTTP traces endpoint, e.g. http://localhost:6006/v1/traces (Phoenix). */
  endpoint: string;
  /** service.name resource attribute. */
  serviceName?: string;
  /** Transport; defaults to a fetch POST with JSON content type. */
  transport?: OtlpTransport;
  /** Clock in ms; defaults to Date.now. */
  now?: () => number;
  /** Hex id generator(bytes); defaults to crypto. Injectable for deterministic tests. */
  randomId?: (bytes: number) => string;
}

type AttrValue = { stringValue: string } | { intValue: string } | { boolValue: boolean };
interface Attr {
  key: string;
  value: AttrValue;
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  status: { code: number };
}

interface TurnTrace {
  traceId: string;
  rootSpanId: string;
  startMs: number;
  brainId: string;
  brainVersion: string;
  mode: string;
  children: OtlpSpan[];
}

const SPAN_KIND_INTERNAL = 1;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

function str(key: string, value: string): Attr {
  return { key, value: { stringValue: value } };
}
function int(key: string, value: number): Attr {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}
function bool(key: string, value: boolean): Attr {
  return { key, value: { boolValue: value } };
}

const defaultTransport: OtlpTransport = async (url, body) => {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
};

/** Builds OTLP traces from runtime events and posts them per finished turn. */
export class OtlpTraceExporter {
  private readonly endpoint: string;
  private readonly serviceName: string;
  private readonly transport: OtlpTransport;
  private readonly now: () => number;
  private readonly randomId: (bytes: number) => string;
  private readonly open = new Map<string, TurnTrace>();

  constructor(options: OtlpExporterOptions) {
    this.endpoint = options.endpoint;
    this.serviceName = options.serviceName ?? "openclaw-agent";
    this.transport = options.transport ?? defaultTransport;
    this.now = options.now ?? (() => Date.now());
    this.randomId = options.randomId ?? ((bytes) => randomBytes(bytes).toString("hex"));
  }

  /** Returns a sink to wire into the runtime telemetry. */
  asSink(): RuntimeEventSink {
    return (event) => this.record(event);
  }

  private record(event: RuntimeEvent): void {
    switch (event.kind) {
      case "turn_started":
        this.open.set(event.sessionId, {
          traceId: this.randomId(16),
          rootSpanId: this.randomId(8),
          startMs: this.now(),
          brainId: event.brainId,
          brainVersion: event.brainVersion,
          mode: event.mode,
          children: [],
        });
        return;
      case "tool_call_finished":
        this.addToolSpan(event);
        return;
      case "inference_finished":
        this.addInferenceSpan(event);
        return;
      case "approval_resolved":
        this.addApprovalSpan(event);
        return;
      case "turn_finished":
        // Other unmatched events (brain_action, sandbox_suspended) carry no span.
        void this.finishTurn(event);
    }
  }

  private addToolSpan(event: Extract<RuntimeEvent, { kind: "tool_call_finished" }>): void {
    const trace = this.open.get(event.sessionId);
    if (!trace) {
      return;
    }
    const end = this.now();
    trace.children.push({
      traceId: trace.traceId,
      spanId: this.randomId(8),
      parentSpanId: trace.rootSpanId,
      name: `execute_tool ${event.capability}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: msToNano(end - event.durationMs),
      endTimeUnixNano: msToNano(end),
      attributes: [
        str("gen_ai.operation.name", "execute_tool"),
        str("gen_ai.tool.name", event.capability),
        bool("openclaw.tool.is_error", event.isError),
        bool("openclaw.tool.replayed", event.replayed),
      ],
      status: { code: event.isError ? STATUS_ERROR : STATUS_OK },
    });
  }

  private addInferenceSpan(event: Extract<RuntimeEvent, { kind: "inference_finished" }>): void {
    const trace = this.open.get(event.sessionId);
    if (!trace) {
      return;
    }
    const at = this.now();
    trace.children.push({
      traceId: trace.traceId,
      spanId: this.randomId(8),
      parentSpanId: trace.rootSpanId,
      name: `chat ${event.tier}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: msToNano(at),
      endTimeUnixNano: msToNano(at),
      attributes: [
        str("gen_ai.operation.name", "chat"),
        str("gen_ai.system", "openclaw"),
        str("openclaw.tier", event.tier),
        int("gen_ai.usage.output_tokens", event.tokensUsed),
      ],
      status: { code: STATUS_OK },
    });
  }

  private addApprovalSpan(event: Extract<RuntimeEvent, { kind: "approval_resolved" }>): void {
    const trace = this.open.get(event.sessionId);
    if (!trace) {
      return;
    }
    const at = this.now();
    trace.children.push({
      traceId: trace.traceId,
      spanId: this.randomId(8),
      parentSpanId: trace.rootSpanId,
      name: `approval ${event.capability}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: msToNano(at),
      endTimeUnixNano: msToNano(at),
      attributes: [
        str("gen_ai.operation.name", "approval"),
        str("gen_ai.tool.name", event.capability),
        str("openclaw.approval.decision", event.decision),
        str("openclaw.risk_class", event.riskClass),
      ],
      status: { code: STATUS_OK },
    });
  }

  private async finishTurn(event: Extract<RuntimeEvent, { kind: "turn_finished" }>): Promise<void> {
    const trace = this.open.get(event.sessionId);
    if (!trace) {
      return;
    }
    this.open.delete(event.sessionId);
    const end = this.now();
    const root: OtlpSpan = {
      traceId: trace.traceId,
      spanId: trace.rootSpanId,
      name: `agent_turn ${trace.mode}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: msToNano(trace.startMs),
      endTimeUnixNano: msToNano(end),
      attributes: [
        str("gen_ai.system", "openclaw"),
        str("gen_ai.operation.name", "invoke_agent"),
        str("openclaw.brain.id", trace.brainId),
        str("openclaw.brain.version", trace.brainVersion),
        str("openclaw.mode", trace.mode),
        str("openclaw.turn.status", event.status),
        int("openclaw.turn.tool_calls", event.toolCalls),
        int("gen_ai.usage.output_tokens", event.tokensUsed),
      ],
      status: { code: event.status === "error" ? STATUS_ERROR : STATUS_OK },
    };
    const payload = this.buildPayload([root, ...trace.children]);
    await this.transport(this.endpoint, JSON.stringify(payload));
  }

  private buildPayload(spans: OtlpSpan[]): unknown {
    return {
      resourceSpans: [
        {
          resource: { attributes: [str("service.name", this.serviceName)] },
          scopeSpans: [{ scope: { name: "openclaw.loop-runtime" }, spans }],
        },
      ],
    };
  }
}

function msToNano(ms: number): string {
  return `${Math.trunc(ms)}000000`;
}
