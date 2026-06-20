// RemoteSandbox: the concrete cloud-general provider whose execution side lives
// in a remote sandbox service (a managed container/workspace). The loop runs
// wherever the runtime runs; this provider forwards each capability invocation
// to the remote service over a narrow transport port and returns the result.
// It mirrors ClientNodeSandbox's shape: the package stays free of any HTTP
// client, the transport is injected, and a default fetch-based transport ships
// alongside for production use.

import type { SandboxKind, SandboxPrimitive } from "../../capability-contract/src/index.js";
import {
  SandboxUnavailableError,
  type CapabilityInvocation,
  type CapabilityResult,
  type SandboxBinding,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxStatus,
} from "./provider.js";

/** Connection-level failure codes; these suspend the session, not the call. */
export type RemoteUnavailableCode = "TIMEOUT" | "UNAVAILABLE" | "DISCONNECTED";

/** Outcome of a remote capability invocation. `ok:false` is a transport
 * failure (the service is gone/unreachable); a capability that ran and failed
 * still returns `ok:true` with `result.isError === true`. */
export type RemoteInvokeOutcome =
  | { ok: true; result: { isError: boolean; output: string; details?: unknown } }
  | { ok: false; code: RemoteUnavailableCode; message: string };

/** Narrow transport to a remote sandbox service. Implemented over HTTP in
 * production (see HttpRemoteSandboxTransport); faked in tests. */
export interface RemoteSandboxTransport {
  /** Creates or attaches the remote sandbox for a binding. */
  ensure(binding: SandboxBinding): Promise<{ sandboxId: string; primitives: SandboxPrimitive[] }>;
  /** Dispatches one capability invocation and awaits the service's response. */
  invoke(request: {
    sandboxId: string;
    capability: string;
    args: unknown;
    idempotencyKey: string;
  }): Promise<RemoteInvokeOutcome>;
  /** Liveness probe for a remote sandbox. */
  status(sandboxId: string): Promise<{ healthy: boolean; detail?: string }>;
  /** Releases the remote sandbox instance. */
  release(sandboxId: string): Promise<void>;
}

/** Sandbox backed by a remote execution service via an injected transport. */
export class RemoteSandbox implements SandboxProvider {
  readonly kind: SandboxKind = "cloud-general";

  // Honors the provider idempotency contract regardless of service behavior: a
  // replayed key returns the cached result without re-dispatching the effect.
  private readonly idempotencyCache = new Map<string, CapabilityResult>();

  constructor(private readonly transport: RemoteSandboxTransport) {}

  async ensureReady(binding: SandboxBinding): Promise<SandboxHandle> {
    let info: { sandboxId: string; primitives: SandboxPrimitive[] };
    try {
      info = await this.transport.ensure(binding);
    } catch (error) {
      throw new SandboxUnavailableError(
        binding.workspaceId ?? "cloud-general",
        `ensure failed: ${String(error)}`,
      );
    }
    return { sandboxId: info.sandboxId, kind: this.kind, primitives: info.primitives };
  }

  async release(handle: SandboxHandle): Promise<void> {
    // Releasing a session must never throw; a best-effort remote release is
    // enough — the service reaps idle sandboxes on its own.
    await this.transport.release(handle.sandboxId).catch(() => {});
  }

  async heartbeat(handle: SandboxHandle): Promise<SandboxStatus> {
    try {
      const status = await this.transport.status(handle.sandboxId);
      return status.healthy
        ? { healthy: true }
        : { healthy: false, detail: status.detail ?? "remote sandbox unhealthy" };
    } catch (error) {
      return { healthy: false, detail: `status failed: ${String(error)}` };
    }
  }

  async invoke(
    handle: SandboxHandle,
    invocation: CapabilityInvocation,
  ): Promise<CapabilityResult> {
    const cached = this.idempotencyCache.get(invocation.idempotencyKey);
    if (cached) {
      return { ...cached, replayed: true };
    }

    const outcome = await this.transport.invoke({
      sandboxId: handle.sandboxId,
      capability: invocation.capability,
      args: invocation.args,
      idempotencyKey: invocation.idempotencyKey,
    });

    if (!outcome.ok) {
      // Transport failure: the service is gone or unresponsive. Surface as
      // unavailable so the runtime suspends the session rather than recording a
      // misleading capability error.
      throw new SandboxUnavailableError(handle.sandboxId, `${outcome.code}: ${outcome.message}`);
    }

    const result: CapabilityResult = {
      isError: outcome.result.isError,
      output: outcome.result.output,
      ...(outcome.result.details !== undefined ? { details: outcome.result.details } : {}),
    };
    this.idempotencyCache.set(invocation.idempotencyKey, result);
    return result;
  }
}

/** Minimal fetch shape the HTTP transport depends on (so it can be injected). */
export type RemoteFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

/** Options for the default HTTP transport. */
export interface HttpRemoteSandboxTransportOptions {
  /** Base URL of the remote sandbox service, e.g. "https://sbx.example.com". */
  baseUrl: string;
  /** Fetch implementation. Defaults to global fetch; tests inject a fake. */
  fetchImpl?: RemoteFetch;
  /** Static headers (auth token, tenant id, …) sent with every request. */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. Default 30s. */
  timeoutMs?: number;
}

const DEFAULT_REMOTE_TIMEOUT_MS = 30_000;

/** Default HTTP transport: maps each transport op to a JSON POST. The remote
 * service is expected to expose `/ensure`, `/invoke`, `/status`, `/release`
 * relative to `baseUrl`. */
export class HttpRemoteSandboxTransport implements RemoteSandboxTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: RemoteFetch;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: HttpRemoteSandboxTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  }

  async ensure(binding: SandboxBinding): Promise<{
    sandboxId: string;
    primitives: SandboxPrimitive[];
  }> {
    const json = await this.postJson("/ensure", binding);
    const record = asRecord(json);
    const sandboxId = typeof record.sandboxId === "string" ? record.sandboxId : "";
    if (!sandboxId) {
      throw new Error("remote ensure did not return a sandboxId");
    }
    const primitives = Array.isArray(record.primitives)
      ? (record.primitives.filter((p) => typeof p === "string") as SandboxPrimitive[])
      : [];
    return { sandboxId, primitives };
  }

  async invoke(request: {
    sandboxId: string;
    capability: string;
    args: unknown;
    idempotencyKey: string;
  }): Promise<RemoteInvokeOutcome> {
    let json: unknown;
    try {
      json = await this.postJson("/invoke", request);
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        code: aborted ? "TIMEOUT" : "UNAVAILABLE",
        message: String(error),
      };
    }
    const record = asRecord(json);
    if (record.ok === false) {
      const code = record.code;
      return {
        ok: false,
        code:
          code === "TIMEOUT" || code === "DISCONNECTED" || code === "UNAVAILABLE"
            ? code
            : "UNAVAILABLE",
        message: typeof record.message === "string" ? record.message : "remote invoke failed",
      };
    }
    const result = asRecord(record.result);
    return {
      ok: true,
      result: {
        isError: result.isError === true,
        output: typeof result.output === "string" ? result.output : "",
        ...(result.details !== undefined ? { details: result.details } : {}),
      },
    };
  }

  async status(sandboxId: string): Promise<{ healthy: boolean; detail?: string }> {
    const json = await this.postJson("/status", { sandboxId });
    const record = asRecord(json);
    return {
      healthy: record.healthy === true,
      ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
    };
  }

  async release(sandboxId: string): Promise<void> {
    await this.postJson("/release", { sandboxId });
  }

  private async postJson(pathname: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`remote sandbox ${pathname} returned http ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
