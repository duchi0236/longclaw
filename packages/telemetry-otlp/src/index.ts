// Telemetry OTLP package: exports runtime traces as OpenTelemetry GenAI spans
// to any OTLP/HTTP endpoint, so an independent tool (Phoenix, Langfuse, …)
// can visualize and analyze a conversation or task — decoupled from the agent.
export * from "./otlp-exporter.js";
