/**
 * Batch-settlement rent cleanup. The worker is
 * {@link PaymentChannelRentCleanupManager}; this subclass fixes the scheme's
 * abandon policy: non-expiring vouchers abandon after `maxIdleSecs` without
 * facilitator-visible activity, and Closing channels are sealed once onchain
 * grace elapses.
 */

import type { Network } from "@x402/core/types";

import {
  PaymentChannelRentCleanupManager,
  type PaymentChannelRentCleanupManagerConfig,
} from "../../payment-channels/rentCleanup";
import type { PaymentChannelStorage } from "../../payment-channels/storage";
import type { FacilitatorSvmSigner } from "../../signer";

export {
  DEFAULT_ABANDON_GRACE_SECS,
  DEFAULT_MAX_CLOSES_PER_RUN,
  DEFAULT_MAX_IDLE_SECS,
  DEFAULT_MAX_RECLAIMS_PER_TX,
  DEFAULT_MAX_TXS_PER_RUN,
  DEFAULT_MAX_TXS_PER_SIGNER,
  MAX_SAFE_RECLAIMS_PER_TX,
} from "../../payment-channels/rentCleanup";
export type {
  RentCleanupCloseResult,
  RentCleanupOptions,
  RentCleanupReclaimResult,
  RentCleanupStartConfig,
  RentDiscoveryOptions,
  RentDiscoveryResult,
} from "../../payment-channels/rentCleanup";

/** Configuration for {@link BatchSvmRentCleanupManager}. */
export interface BatchSvmRentCleanupManagerConfig {
  signer: FacilitatorSvmSigner;
  storage: PaymentChannelStorage;
  network: Network;
  /**
   * Idle window the facilitator advertises as `extra.maxIdleSecs`. Passed into
   * cleanup passes that do not override {@link RentCleanupOptions.maxIdleSecs}.
   */
  maxIdleSecs?: number;
}

/**
 * Storage-driven rent cleanup worker for SVM batch settlement.
 *
 * Operators opt in via {@link PaymentChannelRentCleanupManager.start} or an
 * external cron calling {@link PaymentChannelRentCleanupManager.cleanup}; the
 * facilitator scheme never auto-starts this.
 */
export class BatchSvmRentCleanupManager extends PaymentChannelRentCleanupManager {
  /**
   * Create a rent cleanup manager for one network.
   *
   * @param config - Signer pool, channel storage, and network
   */
  constructor(config: BatchSvmRentCleanupManagerConfig) {
    const shared: PaymentChannelRentCleanupManagerConfig = {
      ...config,
      abandonPolicy: "idle",
      label: "BatchSvmRentCleanupManager",
      sealClosingChannels: true,
    };
    super(shared);
  }
}
