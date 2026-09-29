import type { Network } from "@x402/core/types";

import { BatchError } from "../errors";

/** The receiver authorizer a channel was opened for, from its binding memo. */
export interface BatchReceiverAuthorizerBinding {
  network: Network;
  channelId: string;
  receiverAuthorizer: string;
}

/** Thrown by {@link BatchReceiverAuthorizerStore.bind} when a different key owns the channel. */
export class BatchReceiverAuthorizerConflictError extends Error {
  /** Create an error when a channel is already bound to a different receiver authorizer. */
  constructor() {
    super("receiver authorizer binding already exists for a different key");
    this.name = "BatchReceiverAuthorizerConflictError";
  }
}

/**
 * Pluggable store of channel receiver-authorizer bindings.
 *
 * `bind` is keyed by `(network, channelId)` and is first-writer-wins:
 *
 * - no existing row → insert
 * - existing row, same `receiverAuthorizer` → success (idempotent retry after
 *   bind-then-broadcast-fail)
 * - existing row, different `receiverAuthorizer` → {@link BatchReceiverAuthorizerConflictError}
 *
 * The payer-signed binding memo makes a lost row reconstructable from the
 * open transaction. This implementation assumes the facilitator keeps the row.
 */
export interface BatchReceiverAuthorizerStore {
  bind(binding: BatchReceiverAuthorizerBinding): Promise<void>;
  get(network: Network, channelId: string): Promise<BatchReceiverAuthorizerBinding | undefined>;
  delete(network: Network, channelId: string): Promise<void>;
}

/**
 * In-memory {@link BatchReceiverAuthorizerStore}. A multi-replica facilitator
 * should inject a shared implementation.
 */
export class InMemoryBatchReceiverAuthorizerStore implements BatchReceiverAuthorizerStore {
  private readonly bindings = new Map<string, BatchReceiverAuthorizerBinding>();

  /**
   * Record the receiver authorizer for a channel. First writer wins.
   *
   * @param binding - Network, channel, and receiver authorizer
   */
  async bind(binding: BatchReceiverAuthorizerBinding): Promise<void> {
    const key = bindingKey(binding.network, binding.channelId);
    const existing = this.bindings.get(key);
    if (existing) {
      if (existing.receiverAuthorizer === binding.receiverAuthorizer) return;
      throw new BatchReceiverAuthorizerConflictError();
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
  async get(
    network: Network,
    channelId: string,
  ): Promise<BatchReceiverAuthorizerBinding | undefined> {
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
 * Require a channel's stored binding to be the advertised key.
 *
 * @param bound - Resolved binding, undefined when unavailable
 * @param advertised - `extra.receiverAuthorizer` of the request
 * @param channelId - Channel PDA, for the message
 * @returns The bound key
 */
export function requireReceiverAuthorizer(
  bound: string | undefined,
  advertised: string,
  channelId: string,
): string {
  if (bound === undefined) {
    throw new Error(
      `${BatchError.RECEIVER_BINDING_UNAVAILABLE}: no receiver authorizer is bound to ${channelId}`,
    );
  }
  if (bound !== advertised) {
    throw new Error(
      `${BatchError.RECEIVER_AUTHORIZER_MISMATCH}: advertised key is not the channel's binding`,
    );
  }
  return bound;
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
