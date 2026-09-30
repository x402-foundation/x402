/**
 * Per-channel server state and the store that holds it.
 *
 * `batch-settlement` is stateful: the operator tracks each channel's deposit,
 * the highest accepted off-chain voucher (the watermark), and the on-chain
 * settled / distributed amounts. The default {@link MemoryChannelStore} is an
 * in-memory implementation with per-channel serialization; integrators swap in
 * a durable store for production. See the spec's §7 "Server state".
 */

import type { ChannelState, ChannelStore } from "./types";

/** In-memory {@link ChannelStore} with per-channel serialization. */
export class MemoryChannelStore implements ChannelStore {
  private readonly channels = new Map<string, ChannelState>();
  private readonly locks = new Map<string, Promise<unknown>>();

  /** @inheritdoc */
  /**
   * @inheritdoc
   * @returns Every channel this store holds
   */
  list(): Promise<ChannelState[]> {
    return Promise.resolve([...this.channels.values()]);
  }

  /**
   * @inheritdoc
   * @param channelId - Channel PDA (base58)
   * @returns The state, or undefined if unknown
   */
  get(channelId: string): Promise<ChannelState | undefined> {
    return Promise.resolve(this.channels.get(channelId));
  }

  /** @inheritdoc */
  put(state: ChannelState): Promise<void> {
    this.channels.set(state.channelId, state);
    return Promise.resolve();
  }

  /** @inheritdoc */
  async update(
    channelId: string,
    updater: (current: ChannelState | undefined) => ChannelState | Promise<ChannelState>,
  ): Promise<ChannelState> {
    const prior = this.locks.get(channelId) ?? Promise.resolve();
    const run = prior.then(async () => {
      const next = await updater(this.channels.get(channelId));
      this.channels.set(channelId, next);
      return next;
    });
    // Keep the lock chain alive regardless of this run's outcome.
    this.locks.set(
      channelId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}
