/**
 * `upto` rent cleanup. The worker is {@link PaymentChannelRentCleanupManager};
 * this subclass fixes the scheme's abandon policy: Open channels close at
 * `expiresAt + grace`, and Closing channels are left alone.
 */

import type { Network } from "@x402/core/types";

import {
  type FacilitatorTransactionVersion,
  resolveFacilitatorTransactionVersion,
} from "../../payment-channels/facilitator";
import {
  PaymentChannelRentCleanupManager,
  type PaymentChannelRentCleanupManagerConfig,
} from "../../payment-channels/rentCleanup";
import type { FacilitatorSvmSigner } from "../../signer";
import type { PaymentChannelStorage } from "../../payment-channels/storage";

export {
  DEFAULT_ABANDON_GRACE_SECS,
  DEFAULT_MAX_CLOSES_PER_RUN,
  DEFAULT_MAX_RECLAIMS_PER_TX,
  DEFAULT_MAX_RECLAIMS_PER_TX_V1,
  DEFAULT_MAX_TXS_PER_RUN,
  DEFAULT_MAX_TXS_PER_SIGNER,
  MAX_SAFE_RECLAIMS_PER_TX,
} from "../../payment-channels/rentCleanup";
export {
  DEFAULT_FACILITATOR_TRANSACTION_VERSION,
  resolveFacilitatorTransactionVersion,
} from "../../payment-channels/facilitator";
export type {
  RentCleanupCloseResult,
  RentCleanupOptions,
  RentCleanupReclaimResult,
  RentCleanupStartConfig,
  RentDiscoveryOptions,
  RentDiscoveryResult,
} from "../../payment-channels/rentCleanup";

/** Configuration for {@link UptoSvmRentCleanupManager}. */
export interface UptoSvmRentCleanupManagerConfig {
  signer: FacilitatorSvmSigner;
  storage: PaymentChannelStorage;
  network: Network;
  /**
   * `SetComputeUnitPrice` (microlamports per compute unit) attached to cleanup
   * transactions; `0` omits the instruction. Defaults to
   * `DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS` (1). Under v1 it is converted to
   * the inline total priority fee.
   */
  computeUnitPriceMicroLamports?: number;
  /**
   * `SetComputeUnitLimit` for close/distribute cleanup transactions. Defaults
   * to `DEFAULT_SETTLE_COMPUTE_UNIT_LIMIT` (100k, standard SPL Token
   * settlement); raise it for compute-heavy Token-2022 extension mints.
   * Reclaim batches instead derive their limit per channel
   * (`reclaimComputeUnitLimit`) and are mint-independent. Under v1 it is the
   * inline compute-unit limit.
   */
  settleComputeUnitLimit?: number;
  /**
   * Inline v1 loaded-account-data budget for close/distribute cleanup
   * transactions. Defaults to 4 MiB; reclaim batches derive their own limit.
   * Ignored under v0, which has no loaded-account-data instruction.
   */
  settleLoadedAccountsDataSizeLimit?: number;
  /**
   * Message version (0 or 1) of the cleanup transactions the facilitator
   * builds itself; see `UptoSvmFacilitatorConfig.facilitatorTransactionVersion`.
   * v0 caps reclaim batches at `MAX_SAFE_RECLAIMS_PER_TX`. Defaults to 1.
   */
  facilitatorTransactionVersion?: FacilitatorTransactionVersion;
  /** Treasury owner override; see `UptoSvmFacilitatorConfig.paymentChannelsTreasuryOwner`. */
  treasuryOwner?: string | undefined;
}

/**
 * Storage-driven rent cleanup worker for SVM `upto`.
 *
 * Operators opt in via {@link PaymentChannelRentCleanupManager.start} or an
 * external cron calling {@link PaymentChannelRentCleanupManager.cleanup}; the
 * facilitator scheme never auto-starts this.
 */
export class UptoSvmRentCleanupManager extends PaymentChannelRentCleanupManager {
  /**
   * Create a rent cleanup manager for one network.
   *
   * @param config - Signer pool, channel storage, and network
   */
  constructor(config: UptoSvmRentCleanupManagerConfig) {
    const shared: PaymentChannelRentCleanupManagerConfig = {
      ...config,
      abandonPolicy: "expiry",
      label: "UptoSvmRentCleanupManager",
      sealClosingChannels: false,
      facilitatorTransactionVersion: resolveFacilitatorTransactionVersion(
        config.facilitatorTransactionVersion,
      ),
    };
    super(shared);
  }
}
