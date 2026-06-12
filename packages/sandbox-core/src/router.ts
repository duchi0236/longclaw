// Sandbox router: maps a session's sandbox binding to a provider and caches
// one live handle per session. Switching a session to another device or
// sandbox kind is just a binding change — the loop never notices.

import type { SandboxKind } from "../../capability-contract/src/index.js";
import type { SandboxBinding, SandboxHandle, SandboxProvider } from "./provider.js";

/** Routes capability execution to the provider a session is bound to. */
export class SandboxRouter {
  private readonly providers = new Map<SandboxKind, SandboxProvider>();
  private readonly leases = new Map<string, { provider: SandboxProvider; handle: SandboxHandle }>();

  register(provider: SandboxProvider): void {
    if (this.providers.has(provider.kind)) {
      throw new Error(`provider for sandbox kind "${provider.kind}" already registered`);
    }
    this.providers.set(provider.kind, provider);
  }

  providerFor(kind: SandboxKind): SandboxProvider {
    const provider = this.providers.get(kind);
    if (!provider) {
      throw new Error(`no sandbox provider registered for kind "${kind}"`);
    }
    return provider;
  }

  /**
   * Returns the live lease for a session, creating one through the bound
   * provider on first use. A session holds at most one lease at a time.
   */
  async acquire(
    sessionId: string,
    binding: SandboxBinding,
  ): Promise<{ provider: SandboxProvider; handle: SandboxHandle }> {
    const existing = this.leases.get(sessionId);
    if (existing && existing.provider.kind === binding.kind) {
      return existing;
    }
    if (existing) {
      // Binding changed kind (e.g. moved from cloud to a client device).
      await existing.provider.release(existing.handle);
      this.leases.delete(sessionId);
    }
    const provider = this.providerFor(binding.kind);
    const handle = await provider.ensureReady(binding);
    const lease = { provider, handle };
    this.leases.set(sessionId, lease);
    return lease;
  }

  /** Releases a session's lease if it holds one. */
  async releaseSession(sessionId: string): Promise<void> {
    const lease = this.leases.get(sessionId);
    if (!lease) {
      return;
    }
    this.leases.delete(sessionId);
    await lease.provider.release(lease.handle);
  }
}
