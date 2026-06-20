// Brain-acp package: a brain that delegates each turn to an external agent
// harness (e.g. Claude Code) over ACP, while OpenClaw keeps tools, sandbox,
// approval, memory, and channels. Depends only on the brain contract and a
// narrow ACP session transport port.
export * from "./acp-transport.js";
export * from "./acp-brain.js";
