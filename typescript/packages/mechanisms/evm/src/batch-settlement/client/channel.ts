import { decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { getAddress } from "viem";
import type { ClientEvmSigner } from "../../signer";
import { batchSettlementABI } from "../abi";
import { BATCH_SETTLEMENT_ADDRESS, MIN_WITHDRAW_DELAY } from "../constants";
import type {
  BatchSettlementChannelStateExtra,
  BatchSettlementPaymentRequirementsExtra,
  ChannelConfig,
} from "../types";
import { computeChannelId } from "../utils";
import type { BatchSettlementClientContext, ClientChannelStorage } from "./storage";

/**
 * Runtime dependency bag shared by every storage-bound client helper (channel,
 * recovery, refund) and the {@link BatchSettlementEvmScheme} class.
 */
export interface BatchSettlementClientDeps {
  signer: ClientEvmSigner;
  storage: ClientChannelStorage;
  salt: `0x${string}`;
  payerAuthorizer?: `0x${string}`;
  voucherSigner?: ClientEvmSigner;
}

/**
 * Constructs the immutable {@link ChannelConfig} from payment requirements and
 * a client deps bag (signer, salt, optional payerAuthorizer / voucherSigner).
 *
 * @param deps - Client identity inputs.
 * @param paymentRequirements - Server payment requirements providing receiver, asset, and extra fields.
 * @returns The ChannelConfig that uniquely identifies this payment channel.
 */
export function buildChannelConfig(
  deps: BatchSettlementClientDeps,
  paymentRequirements: PaymentRequirements,
): ChannelConfig {
  const extra = paymentRequirements.extra as
    | Partial<BatchSettlementPaymentRequirementsExtra>
    | undefined;
  const receiverAuthorizer = extra?.receiverAuthorizer;
  if (
    !receiverAuthorizer ||
    getAddress(receiverAuthorizer) === "0x0000000000000000000000000000000000000000"
  ) {
    throw new Error("Payment requirements must include a non-zero extra.receiverAuthorizer");
  }

  return {
    payer: deps.signer.address,
    payerAuthorizer: getAddress(
      deps.payerAuthorizer ?? deps.voucherSigner?.address ?? deps.signer.address,
    ),
    receiver: paymentRequirements.payTo as `0x${string}`,
    receiverAuthorizer: getAddress(receiverAuthorizer),
    token: paymentRequirements.asset as `0x${string}`,
    withdrawDelay:
      typeof extra?.withdrawDelay === "number" ? extra.withdrawDelay : MIN_WITHDRAW_DELAY,
    salt: deps.salt,
  };
}

/**
 * Local inputs for applying a deposit or voucher settle.
 *
 * `requestAmount` is the per-request maximum (`PaymentRequirements.amount`);
 * the voucher ceiling was `chargedCumulativeAmount + requestAmount`.
 * `depositAmount` is `payload.deposit.amount` for this payment and is added to
 * previous local `balance` after settle. Omit it on voucher-only.
 */
export type ChannelSettleLocal = {
  channelId: `0x${string}`;
  requestAmount: string;
  depositAmount?: string;
};

/**
 * Updates local channel state after a deposit or voucher settle.
 *
 * Next cumulative is previous local `chargedCumulativeAmount` plus
 * `server.chargedAmount` (capped at `local.requestAmount`). Next balance is
 * previous local `balance` plus `local.depositAmount` when present;
 * voucher-only leaves balance unchanged. The write is skipped when extra
 * `chargedCumulativeAmount` is present and is not a non-negative integer equal
 * to that next cumulative. Server `channelState` fields are never copied.
 *
 * @param storage - Client channel storage.
 * @param input - Server-reported charge and client-owned settle inputs.
 * @param input.server - Untrusted settlement response fields.
 * @param input.server.chargedAmount - Untrusted `PAYMENT-RESPONSE` extra.chargedAmount.
 * @param input.server.chargedCumulativeAmount - Untrusted extra.channelState.chargedCumulativeAmount.
 * @param input.local - Client-computed channel id, request maximum, and optional deposit.
 */
export async function updateChannelFromSettle(
  storage: ClientChannelStorage,
  input: {
    server: { chargedAmount?: string; chargedCumulativeAmount?: string };
    local: ChannelSettleLocal;
  },
): Promise<void> {
  const { server, local } = input;
  let chargedAmount = 0n;
  if (server.chargedAmount !== undefined) {
    if (!/^\d+$/.test(server.chargedAmount)) {
      throw new Error("invalid chargedAmount: not a non-negative integer");
    }
    chargedAmount = BigInt(server.chargedAmount);
  }
  const requestAmount = BigInt(local.requestAmount);
  if (chargedAmount > requestAmount) {
    throw new Error("settle response chargedAmount exceeds PaymentRequirements.amount");
  }

  const key = local.channelId.toLowerCase();
  const previous = await storage.get(key);
  const depositAmount = local.depositAmount === undefined ? undefined : BigInt(local.depositAmount);

  if (!previous && chargedAmount === 0n && depositAmount === undefined) {
    return;
  }

  const nextChargedCumulative = BigInt(previous?.chargedCumulativeAmount ?? "0") + chargedAmount;
  if (server.chargedCumulativeAmount !== undefined) {
    if (
      !/^\d+$/.test(server.chargedCumulativeAmount) ||
      BigInt(server.chargedCumulativeAmount) !== nextChargedCumulative
    ) {
      return;
    }
  }

  const next: BatchSettlementClientContext = { ...(previous ?? {}) };
  next.chargedCumulativeAmount = nextChargedCumulative.toString();

  if (depositAmount !== undefined) {
    next.balance = (BigInt(previous?.balance ?? "0") + depositAmount).toString();
  }

  await storage.set(key, next);
}

/**
 * Updates local channel state after a cooperative refund the client signed.
 *
 * Omitted `refundAmount` is a full refund: delete the local record. Otherwise
 * the signed amount is capped to the locally expected refundable balance.
 * Delete the record when that drains the refundable balance; otherwise subtract
 * the effective refund from balance. Cumulative is unchanged, and server
 * `channelState` is not an input.
 *
 * @param storage - Client channel storage.
 * @param channelKey - Lowercased client-computed channel id used as the storage key.
 * @param refundAmount - Partial refund the client signed; omit for a full refund.
 */
export async function updateChannelAfterRefund(
  storage: ClientChannelStorage,
  channelKey: string,
  refundAmount?: string,
): Promise<void> {
  if (refundAmount === undefined) {
    await storage.delete(channelKey);
    return;
  }

  const amount = BigInt(refundAmount);
  const previous = await storage.get(channelKey);
  const previousBalance = BigInt(previous?.balance ?? "0");
  const chargedCumulativeAmount = BigInt(previous?.chargedCumulativeAmount ?? "0");
  const refundableBalance =
    previousBalance > chargedCumulativeAmount ? previousBalance - chargedCumulativeAmount : 0n;
  if (amount >= refundableBalance) {
    await storage.delete(channelKey);
    return;
  }

  const next: BatchSettlementClientContext = { ...(previous ?? {}) };
  next.balance = (previousBalance - amount).toString();
  await storage.set(channelKey, next);
}

/**
 * Processes the `PAYMENT-RESPONSE` header after a successful request.
 *
 * Decodes the untrusted header and delegates to {@link updateChannelFromSettle}
 * with server `chargedAmount`, optional extra cumulative, and the caller-supplied
 * local channel inputs.
 *
 * @param storage - Client channel storage.
 * @param getHeader - Function to retrieve a response header by name.
 * @param local - Channel id, per-request maximum, and optional deposit from this payment.
 * @param local.channelId - Client-computed channel id used as the storage key.
 * @param local.requestAmount - Per-request maximum (`PaymentRequirements.amount`).
 * @param local.depositAmount - `payload.deposit.amount` from this payment.
 */
export async function processPaymentResponse(
  storage: ClientChannelStorage,
  getHeader: (name: string) => string | null | undefined,
  local: ChannelSettleLocal,
): Promise<void> {
  const raw = getHeader("PAYMENT-RESPONSE");
  if (!raw) return;

  const settle = decodePaymentResponseHeader(raw);
  if (!settle.success) return;

  const chargedAmount = settle.extra?.chargedAmount;
  if (chargedAmount !== undefined && typeof chargedAmount !== "string") {
    throw new Error("invalid chargedAmount: not a non-negative integer");
  }
  const channelState = settle.extra?.channelState as BatchSettlementChannelStateExtra | undefined;
  await updateChannelFromSettle(storage, {
    server: {
      chargedAmount,
      chargedCumulativeAmount: channelState?.chargedCumulativeAmount,
    },
    local,
  });
}

/**
 * Recovers a channel record from onchain state (useful after a cold start or
 * channel record loss).
 *
 * @param deps - Signer + storage + identity inputs.
 * @param paymentRequirements - Server payment requirements used to derive the ChannelConfig.
 * @returns The recovered client context.
 */
export async function recoverChannel(
  deps: BatchSettlementClientDeps,
  paymentRequirements: PaymentRequirements,
): Promise<BatchSettlementClientContext> {
  if (!deps.signer.readContract) {
    throw new Error("recoverChannel requires ClientEvmSigner.readContract");
  }

  const config = buildChannelConfig(deps, paymentRequirements);
  const channelId = computeChannelId(config, paymentRequirements.network);

  const [chBalance, chTotalClaimed] = await readChannelBalanceAndTotalClaimed(
    deps.signer,
    channelId,
  );

  const ctx: BatchSettlementClientContext = {
    chargedCumulativeAmount: chTotalClaimed.toString(),
    balance: chBalance.toString(),
    totalClaimed: chTotalClaimed.toString(),
  };

  await deps.storage.set(channelId.toLowerCase(), ctx);
  return ctx;
}

/**
 * Reads `channels(channelId)` returning `[balance, totalClaimed]`.
 *
 * @param signer - Signer providing `readContract`.
 * @param channelId - The `bytes32` channel id to query.
 * @returns Tuple of `[balance, totalClaimed]` as bigints.
 */
export async function readChannelBalanceAndTotalClaimed(
  signer: ClientEvmSigner,
  channelId: `0x${string}`,
): Promise<[bigint, bigint]> {
  if (!signer.readContract) {
    throw new Error("readChannelBalanceAndTotalClaimed requires ClientEvmSigner.readContract");
  }
  return (await signer.readContract({
    address: BATCH_SETTLEMENT_ADDRESS,
    abi: batchSettlementABI,
    functionName: "channels",
    args: [channelId],
  })) as [bigint, bigint];
}

/**
 * Returns whether a local channel record exists for the given channel.
 *
 * @param storage - Client channel storage.
 * @param channelId - The channel identifier to check.
 * @returns `true` when a channel record is stored.
 */
export async function hasChannel(
  storage: ClientChannelStorage,
  channelId: string,
): Promise<boolean> {
  const channel = await storage.get(channelId.toLowerCase());
  return channel !== undefined;
}

/**
 * Returns the local channel context for a channel, if present.
 *
 * @param storage - Client channel storage.
 * @param channelId - The channel identifier.
 * @returns Stored context or `undefined`.
 */
export async function getChannel(
  storage: ClientChannelStorage,
  channelId: string,
): Promise<BatchSettlementClientContext | undefined> {
  return storage.get(channelId.toLowerCase());
}
