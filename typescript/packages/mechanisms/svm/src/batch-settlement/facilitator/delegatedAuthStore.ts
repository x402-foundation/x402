import type { Address } from "@solana/kit";
import type { FacilitatorContext, Network } from "@x402/core/types";

/**
 * Facilitator-delegated receiver authorization.
 *
 * Advertised as `/supported` `extra.receiverAuthorizer`. The facilitator
 * binds the caller's identity at open and requires the same identity to seal
 * or cooperatively refund, so those closes carry no `CloseAuthorization`.
 */
export interface BatchDelegatedReceiverAuth {
  /** Advertised as `/supported` extra.receiverAuthorizer and bound into delegated channels. */
  receiverAuthorizer: Address;
  identityStore: BatchDelegatedAuthStore;
  resolveCallerIdentity(
    ctx: BatchDelegatedSettleContext,
  ): Promise<string | undefined> | string | undefined;
}

/** Context passed to {@link BatchDelegatedReceiverAuth.resolveCallerIdentity}. */
export interface BatchDelegatedSettleContext {
  step: "deposit" | "seal" | "refund";
  channelId: string;
  network: Network;
  payer: string;
  facilitatorContext?: FacilitatorContext | undefined;
}

/**
 * Caller identity bound to a delegated channel at open, so a later seal or
 * cooperative refund can be correlated to the same service.
 *
 * The identity is not onchain. A lost row fails closed: the server can no
 * longer seal or cooperatively refund, and the client falls back to
 * `request_close`.
 */
export interface BatchDelegatedAuthBinding {
  network: Network;
  channelId: string;
  /** Identity `resolveCallerIdentity` returned on the open settle. */
  callerIdentity: string;
}

/** Thrown by {@link BatchDelegatedAuthStore.bind} when a different identity owns the channel. */
export class BatchDelegatedAuthIdentityConflictError extends Error {
  /** Create an error when a channel already has a different delegated identity. */
  constructor() {
    super("delegated auth binding already exists for a different identity");
    this.name = "BatchDelegatedAuthIdentityConflictError";
  }
}

/**
 * Pluggable store of delegated open/close caller-identity bindings.
 *
 * `bind` is keyed by `(network, channelId)` and is first-writer-wins:
 *
 * - no existing row → insert
 * - existing row, same `callerIdentity` → success (idempotent retry after
 *   bind-then-broadcast-fail)
 * - existing row, different `callerIdentity` → {@link BatchDelegatedAuthIdentityConflictError}
 *
 * There is no expiry: a channel lives until it is closed. `get` propagates
 * store errors so a host can map infra failures separately from unauthenticated.
 */
export interface BatchDelegatedAuthStore {
  bind(binding: BatchDelegatedAuthBinding): Promise<void>;
  get(network: Network, channelId: string): Promise<BatchDelegatedAuthBinding | undefined>;
  delete(network: Network, channelId: string): Promise<void>;
}

/**
 * In-memory {@link BatchDelegatedAuthStore}. A multi-replica facilitator must
 * inject a shared implementation; a lost binding fails closed.
 */
export class InMemoryBatchDelegatedAuthStore implements BatchDelegatedAuthStore {
  private readonly bindings = new Map<string, BatchDelegatedAuthBinding>();

  /**
   * Record the caller identity for a channel. First writer wins: a later
   * `bind` with the same identity is a no-op; a different identity is an error.
   *
   * @param binding - Network, channel, and caller identity
   */
  async bind(binding: BatchDelegatedAuthBinding): Promise<void> {
    const key = bindingKey(binding.network, binding.channelId);
    const existing = this.bindings.get(key);
    if (existing) {
      if (existing.callerIdentity === binding.callerIdentity) return;
      throw new BatchDelegatedAuthIdentityConflictError();
    }
    this.bindings.set(key, { ...binding });
  }

  /**
   * Look up a binding.
   *
   * @param network - CAIP-2 network the channel was opened on
   * @param channelId - Channel PDA
   * @returns Stored binding, or undefined when absent
   */
  async get(network: Network, channelId: string): Promise<BatchDelegatedAuthBinding | undefined> {
    const binding = this.bindings.get(bindingKey(network, channelId));
    return binding ? { ...binding } : undefined;
  }

  /**
   * Remove a binding.
   *
   * @param network - CAIP-2 network the channel was opened on
   * @param channelId - Channel PDA
   */
  async delete(network: Network, channelId: string): Promise<void> {
    this.bindings.delete(bindingKey(network, channelId));
  }
}

/**
 * Composite key so the same PDA on two networks cannot collide.
 *
 * @param network - CAIP-2 network
 * @param channelId - Channel PDA
 * @returns Store key
 */
function bindingKey(network: Network, channelId: string): string {
  return `${network}:${channelId}`;
}
