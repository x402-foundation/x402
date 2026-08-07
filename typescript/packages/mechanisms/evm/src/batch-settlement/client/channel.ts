import { decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { getAddress } from "viem";
import type { ClientEvmSigner } from "../../signer";
import { batchSettlementABI } from "../abi";
import { BATCH_SETTLEMENT_ADDRESS, MIN_WITHDRAW_DELAY } from "../constants";
import type {
  BatchSettlementPaymentRequirementsExtra,
  BatchSettlementPaymentResponseExtra,
  ChannelConfig,
} from "../types";
import { computeChannelId } from "../utils";
import type { BatchSettlementClientContext, ClientChannelStorage } from "./storage";

type ResponseChannelState = NonNullable<BatchSettlementPaymentResponseExtra["channelState"]>;

/**
 * Reads the nested channel state from a settlement response extra object.
 *
 * @param extra - Settlement response extra fields.
 * @returns Channel state fields, or undefined when absent.
 */
function readResponseChannelState(
  extra: Record<string, unknown>,
): ResponseChannelState | undefined {
  const channelState = extra.channelState;
  if (typeof channelState !== "object" || channelState === null) {
    return undefined;
  }
  return channelState as ResponseChannelState;
}

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
 * Updates local channel state from a parsed `SettleResponse`.
 *
 * @param storage - Client channel storage.
 * @param settle - The parsed settle response.
 */
export async function processSettleResponse(
  storage: ClientChannelStorage,
  settle: SettleResponse,
): Promise<void> {
  const extra = settle.extra ?? {};
  const channelState = readResponseChannelState(extra);
  if (!channelState) return;

  const channelId = channelState.channelId;
  const key = channelId.toLowerCase();

  const prev = await storage.get(key);
  const next: BatchSettlementClientContext = { ...(prev ?? {}) };

  if (channelState.chargedCumulativeAmount !== undefined) {
    next.chargedCumulativeAmount = String(channelState.chargedCumulativeAmount);
  }
  if (channelState.balance !== undefined) {
    next.balance = String(channelState.balance);
  }
  if (channelState.totalClaimed !== undefined) {
    next.totalClaimed = String(channelState.totalClaimed);
  }

  await storage.set(key, next);
}

/**
 * Reconciles local channel state with the outcome of a cooperative refund.
 *
 * Deletes the channel record when the post-refund balance is zero (full refund),
 * otherwise updates local state from the server snapshot.
 *
 * @param storage - Client channel storage.
 * @param channelKey - Lowercased channel id used as the storage key.
 * @param settleExtra - The `extra` block from the refund settle response.
 */
export async function updateChannelAfterRefund(
  storage: ClientChannelStorage,
  channelKey: string,
  settleExtra: Record<string, unknown>,
): Promise<void> {
  const channelState = readResponseChannelState(settleExtra);
  if (!channelState) {
    await storage.delete(channelKey);
    return;
  }

  const balanceAfter =
    channelState.balance !== undefined ? BigInt(String(channelState.balance)) : undefined;

  if (balanceAfter === undefined || balanceAfter <= 0n) {
    await storage.delete(channelKey);
    return;
  }

  const prev = await storage.get(channelKey);
  const next: BatchSettlementClientContext = { ...(prev ?? {}) };
  next.balance = balanceAfter.toString();
  if (channelState.chargedCumulativeAmount !== undefined) {
    next.chargedCumulativeAmount = String(channelState.chargedCumulativeAmount);
  }
  if (channelState.totalClaimed !== undefined) {
    next.totalClaimed = String(channelState.totalClaimed);
  }
  await storage.set(channelKey, next);
}

/**
 * Processes the `PAYMENT-RESPONSE` header after a successful request.
 *
 * Decodes the header into a `SettleResponse` and delegates to
 * {@link processSettleResponse}.
 *
 * @param storage - Client channel storage.
 * @param getHeader - Function to retrieve a response header by name.
 */
export async function processPaymentResponse(
  storage: ClientChannelStorage,
  getHeader: (name: string) => string | null | undefined,
): Promise<void> {
  const raw = getHeader("PAYMENT-RESPONSE");
  if (!raw) return;

  const settle = decodePaymentResponseHeader(raw);
  await processSettleResponse(storage, settle);
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
