import type { BatchChannelConfig, BatchProof } from "../types";

export type BatchChannelStatus = "open" | "closing" | "distributed";

/** Ceiling held while a verified handler runs, keyed by reservation id on {@link ChannelState}. */
export type ChannelReservation = {
  ceiling: bigint;
  expiresAt: number;
  requestId?: string | undefined;
  kind: "client" | "server" | "close";
};

/** Server-held state for a single channel, keyed by `channelId`. */
export interface ChannelState {
  /** Channel PDA (base58). */
  channelId: string;
  /** Channel payer / depositor (base58). */
  payer: string;
  /** Final payment receiver (base58). */
  receiver: string;
  /** Zero-share program payee and transaction sponsor. */
  feePayer: string;
  /** SPL mint (base58). */
  mint: string;
  /** Token program id for the mint (base58). */
  tokenProgram: string;
  /** Voucher signer = the client (base58). */
  payerAuthorizer: string;
  /** Optional server close authorizer from the challenge. */
  receiverAuthorizer?: string | undefined;
  /** Forced-close grace period. */
  withdrawDelay: number;
  /** Channel PDA salt and open-slot seed. */
  salt: bigint;
  openSlot: bigint;
  /** On-chain escrow deposit (base units). */
  deposit: bigint;
  /** Highest accepted off-chain cumulative (the watermark). */
  chargedCumulativeAmount: bigint;
  /** Highest signed voucher watermark, committed after serving. */
  signedMaxClaimable: bigint;
  /** On-chain settled watermark (advanced by `settleBatch`). */
  settled: bigint;
  /** Cumulative distributed on-chain (base units). */
  payoutWatermark: bigint;
  /** Wall-clock time when facilitator verification last refreshed onchain state. */
  onchainSyncedAt?: number | undefined;
  /** Channel lifecycle status. */
  status: BatchChannelStatus;
  /** When a forced/cooperative close was requested (Unix seconds), if any. */
  closeRequestedAt?: number | undefined;
  /** The highest accepted voucher's signature (base58), for redemption. */
  highestVoucherSignature?: string | undefined;
  /** The highest accepted voucher's expiry (Unix seconds). */
  highestVoucherExpiresAt?: number | undefined;
  /** Canonical wire configuration retained for response and channel binding. */
  channelConfig: BatchChannelConfig;
  /** The broadcast `open` signature, returned in the deposit settlement response. */
  openSignature?: string | undefined;
  /** Broadcast signature for the payer-forced request_close transition. */
  closeSignature?: string | undefined;
  /** Request ceilings reserved while verified handlers execute. */
  reservations?: Record<string, ChannelReservation> | undefined;
}

/**
 * Channel store contract. `update` performs an atomic read-modify-write so that
 * concurrent voucher acceptance for the same channel is serialized.
 */
export interface ChannelStore {
  /**
   * Fetch a channel's state.
   *
   * @param channelId - Channel PDA (base58)
   * @returns The state, or undefined if unknown
   */
  get(channelId: string): Promise<ChannelState | undefined>;

  /**
   * Every channel this store holds.
   *
   * Optional: only a redemption worker needs to enumerate, and a store built
   * for request serving alone can leave it out. Implementations may return a
   * weakly-consistent snapshot — a worker reconciles each channel against the
   * chain anyway.
   */
  list?(): Promise<ChannelState[]>;

  /**
   * Insert or overwrite a channel's state.
   *
   * @param state - The channel state
   */
  put(state: ChannelState): Promise<void>;

  /**
   * Atomically read-modify-write a channel under a per-channel lock. The updater
   * runs with exclusive access; concurrent updates to the same channel queue.
   *
   * @param channelId - Channel PDA (base58)
   * @param updater - Receives the current state (or undefined) and returns the new state
   * @returns The written state
   */
  update(
    channelId: string,
    updater: (current: ChannelState | undefined) => ChannelState | Promise<ChannelState>,
  ): Promise<ChannelState>;
}

/** Per-request bookkeeping the server keeps from verify until settle. */
export type RequestContext = {
  channelId: string;
  /** Deposit, voucher, or authorization. Refund does not fit this union. */
  proof?: BatchProof;
  /** Client-signed cumulative amount, when the payer supplies the voucher. */
  cumulative?: bigint;
  /** Maximum charge advertised before the handler runs. */
  ceiling?: bigint;
  requestId?: string;
  pendingId?: string;
  topUp?: boolean;
  /**
   * Set when local state is absent or stale, so the cumulative rule must be
   * applied after the facilitator refreshes the onchain snapshot.
   */
  requiresCumulativeCheck?: boolean;
};

/** A channel snapshot a facilitator confirmed against the chain. */
export type VerifiedChannelState = {
  channelId?: string | undefined;
  balance?: bigint | undefined;
  totalClaimed: bigint;
  withdrawRequestedAt: number;
};
