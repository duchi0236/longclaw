// Canonical manifests for the core capability families every sandbox kind is
// expected to implement. Concrete providers may register more; these are the
// floor the standard brain can rely on.

import type { CapabilityManifest } from "../../capability-contract/src/index.js";

/** `fs.read` — read one file from the workspace. */
export const FS_READ_MANIFEST: CapabilityManifest = {
  name: "fs.read",
  version: "1.0.0",
  description: "Read a UTF-8 file from the sandbox workspace.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  riskClass: "read",
  sandboxRequires: ["fs"],
  providerKinds: ["cloud-general", "cloud-repo", "client-node"],
};

/** `fs.write` — create or overwrite one file in the workspace. */
export const FS_WRITE_MANIFEST: CapabilityManifest = {
  name: "fs.write",
  version: "1.0.0",
  description: "Create or overwrite a UTF-8 file in the sandbox workspace.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
  riskClass: "write",
  sandboxRequires: ["fs"],
  providerKinds: ["cloud-general", "cloud-repo", "client-node"],
};

/** `fs.list` — list workspace files under a prefix. */
export const FS_LIST_MANIFEST: CapabilityManifest = {
  name: "fs.list",
  version: "1.0.0",
  description: "List files in the sandbox workspace, optionally under a path prefix.",
  inputSchema: {
    type: "object",
    properties: { prefix: { type: "string" } },
  },
  riskClass: "read",
  sandboxRequires: ["fs"],
  providerKinds: ["cloud-general", "cloud-repo", "client-node"],
};

/** `exec.run` — run a command inside the sandbox. */
export const EXEC_RUN_MANIFEST: CapabilityManifest = {
  name: "exec.run",
  version: "1.0.0",
  description: "Run a shell command inside the sandbox and return its output.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "number" },
    },
    required: ["command"],
  },
  riskClass: "execute",
  sandboxRequires: ["proc"],
  providerKinds: ["cloud-general", "cloud-repo", "client-node"],
};

/** `web.fetch` — fetch an http(s) URL and return the response body. */
export const WEB_FETCH_MANIFEST: CapabilityManifest = {
  name: "web.fetch",
  version: "1.0.0",
  description:
    "Fetch an http(s) URL and return the response body as text. Read-only: it never mutates remote state. Output is bounded by a byte cap and the call by a timeout.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      headers: { type: "object" },
      maxBytes: { type: "number" },
      timeoutMs: { type: "number" },
    },
    required: ["url"],
  },
  riskClass: "read",
  sandboxRequires: ["net"],
  providerKinds: ["cloud-general", "cloud-repo", "client-node"],
};

/** `web.search` — run a web search and return ranked results. */
export const WEB_SEARCH_MANIFEST: CapabilityManifest = {
  name: "web.search",
  version: "1.0.0",
  description:
    "Search the web for a query and return ranked results (title, url, snippet). Read-only. Requires the sandbox to be configured with a search backend.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: ["query"],
  },
  riskClass: "read",
  sandboxRequires: ["net"],
  providerKinds: ["cloud-general", "cloud-repo", "client-node"],
};

/** `memory.write` — persist a text note the agent can recall later. */
export const MEMORY_WRITE_MANIFEST: CapabilityManifest = {
  name: "memory.write",
  version: "1.0.0",
  description:
    "Persist a text note into the agent's long-term memory under an optional key, with optional tags. Returns the stored key.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
      text: { type: "string" },
      tags: { type: "array" },
    },
    required: ["text"],
  },
  riskClass: "write",
  sandboxRequires: ["mem"],
  providerKinds: ["cloud-general", "cloud-repo", "client-node"],
};

/** `memory.read` — recall a stored note by key. */
export const MEMORY_READ_MANIFEST: CapabilityManifest = {
  name: "memory.read",
  version: "1.0.0",
  description: "Recall a stored memory note by its key.",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
  },
  riskClass: "read",
  sandboxRequires: ["mem"],
  providerKinds: ["cloud-general", "cloud-repo", "client-node"],
};

/** `memory.search` — find stored notes by a text query. */
export const MEMORY_SEARCH_MANIFEST: CapabilityManifest = {
  name: "memory.search",
  version: "1.0.0",
  description: "Search the agent's memory for notes matching a query and return ranked matches.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: ["query"],
  },
  riskClass: "read",
  sandboxRequires: ["mem"],
  providerKinds: ["cloud-general", "cloud-repo", "client-node"],
};

/** All core manifests, ready to seed a capability registry. */
export const CORE_CAPABILITY_MANIFESTS: CapabilityManifest[] = [
  FS_READ_MANIFEST,
  FS_WRITE_MANIFEST,
  FS_LIST_MANIFEST,
  EXEC_RUN_MANIFEST,
  WEB_FETCH_MANIFEST,
  WEB_SEARCH_MANIFEST,
  MEMORY_WRITE_MANIFEST,
  MEMORY_READ_MANIFEST,
  MEMORY_SEARCH_MANIFEST,
];
