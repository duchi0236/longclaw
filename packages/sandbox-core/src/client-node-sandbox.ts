// ClientNodeSandbox: a sandbox whose execution side lives on the user's own
// device. The loop runs in the cloud; this provider routes each tool call
// down to a paired client node over the reverse-RPC transport and returns the
// result. The cloud never touches the user's filesystem directly — it asks
// the device to.

import { capabilityToNodeCommand, nodeResultToCapability } from "./client-node-protocol.js";
import type { NodeInvoker } from "./node-invoker.js";
import {
  SandboxUnavailableError,
  type CapabilityInvocation,
  type CapabilityResult,
  type SandboxBinding,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxStatus,
} from "./provider.js";

/** Sandbox backed by a paired client device via reverse RPC. */
export class ClientNodeSandbox implements SandboxProvider {
  readonly kind = "client-node" as const;

  // Honors the provider idempotency contract regardless of node behavior: a
  // replayed key returns the cached result without re-dispatching the effect.
  private readonly idempotencyCache = new Map<string, CapabilityResult>();

  constructor(private readonly invoker: NodeInvoker) {}

  async ensureReady(binding: SandboxBinding): Promise<SandboxHandle> {
    const deviceId = this.requireDeviceId(binding);
    const status = await this.invoker.status(deviceId);
    if (!status.connected) {
      throw new SandboxUnavailableError(deviceId, "device not connected");
    }
    return { sandboxId: deviceId, kind: this.kind, primitives: status.primitives };
  }

  release(_handle: SandboxHandle): Promise<void> {
    // The device connection lifecycle is owned by the gateway, not the
    // sandbox; releasing a session must not disconnect the user's device.
    return Promise.resolve();
  }

  async heartbeat(handle: SandboxHandle): Promise<SandboxStatus> {
    const status = await this.invoker.status(handle.sandboxId);
    return status.connected ? { healthy: true } : { healthy: false, detail: "device disconnected" };
  }

  async invoke(handle: SandboxHandle, invocation: CapabilityInvocation): Promise<CapabilityResult> {
    const cached = this.idempotencyCache.get(invocation.idempotencyKey);
    if (cached) {
      return { ...cached, replayed: true };
    }

    const nodeCommand = capabilityToNodeCommand(invocation.capability, invocation.args);
    const outcome = await this.invoker.invoke({
      deviceId: handle.sandboxId,
      command: nodeCommand.command,
      params: nodeCommand.params,
      ...(nodeCommand.timeoutMs !== undefined ? { timeoutMs: nodeCommand.timeoutMs } : {}),
      idempotencyKey: invocation.idempotencyKey,
    });

    if (!outcome.ok) {
      // Transport failure: the device is gone or unresponsive. Surface as
      // unavailable so the runtime suspends the session rather than recording
      // a misleading command error.
      throw new SandboxUnavailableError(handle.sandboxId, `${outcome.code}: ${outcome.message}`);
    }

    const result = nodeResultToCapability(invocation.capability, outcome.result);
    this.idempotencyCache.set(invocation.idempotencyKey, result);
    return result;
  }

  private requireDeviceId(binding: SandboxBinding): string {
    if (!binding.deviceId) {
      throw new Error("client-node sandbox binding requires a deviceId");
    }
    return binding.deviceId;
  }
}
