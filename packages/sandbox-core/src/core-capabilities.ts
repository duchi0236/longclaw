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

/** All core manifests, ready to seed a capability registry. */
export const CORE_CAPABILITY_MANIFESTS: CapabilityManifest[] = [
  FS_READ_MANIFEST,
  FS_WRITE_MANIFEST,
  FS_LIST_MANIFEST,
  EXEC_RUN_MANIFEST,
];
