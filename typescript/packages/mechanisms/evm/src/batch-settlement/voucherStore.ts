import type { PaymentRequirements } from "@x402/core/types";
import type { BatchSettlementPaymentResponseExtra, BatchSettlementVoucherManager } from "./types";
import type { Channel, ChannelStorage } from "./storage/channel";

const MIN_PENDING_TTL_MS = 5_000;
const MAX_PENDING_TTL_MS = 10 * 60 * 1000;

/** Who owns the authoritative offchain voucher store for a request or network. */
export type VoucherStoreMode = "self" | "facilitator";

export type CommitVoucherChargeInput<T extends Channel = Channel> = {
  increment: bigint;
  signedCap: bigint;
  /**
   * When set, the stored (or recovered) `chargedCumulativeAmount` must equal this value before the
   * charge applies. Pins the commit to the watermark `/verify` admitted.
   */
  expectedCharged?: bigint;
  voucher: { maxClaimableAmount: string; signature: string };
  snapshot?: T | ((current: T | undefined) => T | undefined);
  recoverFromSnapshot?: boolean;
  now?: number;
  localVerify?: boolean;
  /** Applied after charge fields. Use to set facilitator extras (network, chargeCount). */
  map?: (updated: T) => T;
};

export type CommitVoucherChargeResult<T extends Channel = Channel> =
  | { status: "missing" }
  | { status: "cap_exceeded"; charged: string }
  | { status: "watermark_mismatch"; charged: string }
  | { status: "committed"; previous: Channel; current: T }
  | { status: "conflict" };

/**
 * Returns whether this request uses a facilitator voucher store.
 *
 * @param requirements - Payment requirements (or any object with `extra`).
 * @param requirements.extra - Optional extra record that may contain `voucherManager`.
 * @returns True when `extra.voucherManager === "facilitator"` (omitted means `"server"`).
 */
export function isFacilitatorManaged(requirements: {
  extra?: Record<string, unknown> | undefined;
}): boolean {
  return requirements.extra?.voucherManager === "facilitator";
}

/**
 * Reads the voucher-management modes a facilitator advertises on `/supported`.
 *
 * `extra.voucherManager` is an array on `/supported`; omitting it means `["server"]`.
 * A malformed (non-array) value advertises nothing.
 *
 * @param extra - The `/supported` kind `extra` record.
 * @returns The advertised modes, restricted to known values.
 */
export function advertisedVoucherManagers(
  extra: Record<string, unknown> | undefined,
): BatchSettlementVoucherManager[] {
  const advertised = extra?.voucherManager;
  if (advertised === undefined) {
    return ["server"];
  }
  if (!Array.isArray(advertised)) {
    return [];
  }
  return advertised.filter(
    (value): value is BatchSettlementVoucherManager =>
      value === "server" || value === "facilitator",
  );
}

/**
 * Resolves {@link VoucherStoreMode} from payment requirements.
 *
 * @param requirements - Current request payment requirements.
 * @returns `"facilitator"` when `extra.voucherManager === "facilitator"`, otherwise `"self"`.
 */
export function voucherStoreMode(requirements: PaymentRequirements): VoucherStoreMode {
  return isFacilitatorManaged(requirements) ? "facilitator" : "self";
}

/**
 * Computes the bounded admission-lock TTL.
 *
 * @param maxTimeoutSeconds - Resource timeout from payment requirements.
 * @returns TTL in milliseconds, clamped to 5s–600s.
 */
export function pendingTtlMs(maxTimeoutSeconds: number | undefined): number {
  const requestedMs = Math.max(0, maxTimeoutSeconds ?? 0) * 1000;
  return Math.min(MAX_PENDING_TTL_MS, Math.max(MIN_PENDING_TTL_MS, requestedMs));
}

/**
 * Derives a reasonable onchain state freshness window from the channel withdraw delay.
 *
 * @param withdrawDelaySeconds - Onchain withdraw delay for the channel, in seconds.
 * @returns TTL in milliseconds, clamped between 30 seconds and 5 minutes.
 */
export function defaultOnchainStateTtlMs(withdrawDelaySeconds: number): number {
  const withdrawDelayMs = Math.max(0, withdrawDelaySeconds) * 1000;
  return Math.min(5 * 60 * 1000, Math.max(30 * 1000, Math.floor(withdrawDelayMs / 3)));
}

/**
 * Converts stored channel state into the public response snapshot shape.
 *
 * @param channel - Stored channel state.
 * @param chargedCumulativeAmount - Optional current charged cumulative amount.
 * @returns Response-ready channel snapshot.
 */
export function channelStateExtra(
  channel: Pick<
    Channel,
    "channelId" | "balance" | "totalClaimed" | "withdrawRequestedAt" | "refundNonce"
  >,
  chargedCumulativeAmount?: string,
): NonNullable<BatchSettlementPaymentResponseExtra["channelState"]> {
  return {
    channelId: channel.channelId as `0x${string}`,
    balance: channel.balance,
    totalClaimed: channel.totalClaimed,
    withdrawRequestedAt: channel.withdrawRequestedAt,
    refundNonce: String(channel.refundNonce),
    ...(chargedCumulativeAmount !== undefined ? { chargedCumulativeAmount } : {}),
  };
}

/**
 * Builds payment-response `extra` with a stable key order.
 *
 * Self-managed paid responses are `channelState`, then `chargedAmount`.
 * Facilitator-managed adds `chargeCount` after that. Refunds omit `chargedAmount`.
 *
 * @param extra - Channel snapshot and optional charge fields.
 * @param extra.channelState - On-chain channel snapshot included in the response.
 * @param extra.chargedAmount - Amount charged for this payment; omitted for refunds.
 * @param extra.chargeCount - Facilitator-managed charge index when applicable.
 * @returns Extra object with keys in declaration order.
 */
export function paymentResponseExtra(extra: {
  channelState: NonNullable<BatchSettlementPaymentResponseExtra["channelState"]>;
  chargedAmount?: string;
  chargeCount?: number;
}): BatchSettlementPaymentResponseExtra {
  return {
    channelState: extra.channelState,
    ...(extra.chargedAmount !== undefined ? { chargedAmount: extra.chargedAmount } : {}),
    ...(extra.chargeCount !== undefined ? { chargeCount: extra.chargeCount } : {}),
  };
}

/**
 * Atomically increments `chargedCumulativeAmount` under the storage CAS.
 *
 * Any storage outcome other than `{ status: "updated" }` with a committed callback result
 * (including `{ status: "conflict" }` from a contended compare-and-write) maps to
 * `{ status: "conflict" }`.
 *
 * @param storage - Durable channel store.
 * @param channelId - Channel to update.
 * @param input - Charge increment, signed cap, voucher, and optional snapshot/map.
 * @returns CAS outcome.
 */
export async function commitVoucherCharge<T extends Channel = Channel>(
  storage: ChannelStorage<T>,
  channelId: string,
  input: CommitVoucherChargeInput<T>,
): Promise<CommitVoucherChargeResult<T>> {
  const now = input.now ?? Date.now();
  let outcome: CommitVoucherChargeResult<T> | undefined;

  const updateResult = await storage.updateChannel(channelId, current => {
    const recover = input.recoverFromSnapshot !== false;
    const resolvedSnapshot =
      typeof input.snapshot === "function" ? input.snapshot(current) : input.snapshot;
    const base = (current ?? (recover ? resolvedSnapshot : undefined)) as T | undefined;
    if (!base) {
      outcome = { status: "missing" };
      return current;
    }

    const charged = BigInt(base.chargedCumulativeAmount);
    if (input.expectedCharged !== undefined && charged !== input.expectedCharged) {
      outcome = { status: "watermark_mismatch", charged: charged.toString() };
      return current;
    }

    const newCharged = charged + input.increment;
    if (newCharged > input.signedCap) {
      outcome = { status: "cap_exceeded", charged: newCharged.toString() };
      return current;
    }

    let updatedChannel = {
      ...base,
      ...(input.localVerify || !resolvedSnapshot
        ? {}
        : {
            balance: resolvedSnapshot.balance,
            totalClaimed: resolvedSnapshot.totalClaimed,
            withdrawRequestedAt: resolvedSnapshot.withdrawRequestedAt,
            refundNonce: resolvedSnapshot.refundNonce,
            onchainSyncedAt: now,
          }),
      chargedCumulativeAmount: newCharged.toString(),
      signedMaxClaimable: input.voucher.maxClaimableAmount,
      signature: input.voucher.signature,
      lastRequestTimestamp: now,
    } as T;
    if (input.map) {
      updatedChannel = input.map(updatedChannel);
    }
    outcome = { status: "committed", previous: base, current: updatedChannel };
    return updatedChannel;
  });

  if (
    outcome?.status === "missing" ||
    outcome?.status === "cap_exceeded" ||
    outcome?.status === "watermark_mismatch"
  ) {
    return outcome;
  }

  if (updateResult.status !== "updated" || outcome?.status !== "committed") {
    return { status: "conflict" };
  }

  return outcome;
}
