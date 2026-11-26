import { getAddress, hashTypedData, isAddressEqual, parseEventLogs, type Log } from "viem";
import type { Network, SettleResponse } from "@x402/core/types";
import { verifyECDSA, verifyHashSignatureWithCode } from "../../shared/verifySignature";
import { FacilitatorEvmSigner } from "../../signer";
import { multicall } from "../../multicall";
import { BATCH_SETTLEMENT_ADDRESS, voucherTypes } from "../constants";
import { batchSettlementABI } from "../abi";
import type { ChannelConfig, ChannelState } from "../types";
import { getBatchSettlementEip712Domain, isContractRecoverableSignature } from "../utils";
import * as Errors from "../errors";

export { validateChannelConfig } from "../utils";

/**
 * Normalises a {@link ChannelConfig} into the checksummed-address tuple expected by the
 * batch-settlement contract's `deposit` / `refundWithSignature` / `claimWithSignature` calls.
 *
 * @param config - In-memory channel configuration.
 * @returns Channel config tuple with all address fields checksummed via `getAddress`.
 */
export function toContractChannelConfig(config: ChannelConfig) {
  return {
    payer: getAddress(config.payer),
    payerAuthorizer: getAddress(config.payerAuthorizer),
    receiver: getAddress(config.receiver),
    receiverAuthorizer: getAddress(config.receiverAuthorizer),
    token: getAddress(config.token),
    withdrawDelay: config.withdrawDelay,
    salt: config.salt,
  };
}

/**
 * Case-insensitive comparison of two channel id hex strings.
 *
 * @param a - First channel id.
 * @param b - Second channel id (may be any unknown value).
 * @returns `true` when both ids refer to the same channel.
 */
export function channelIdsEqual(a: `0x${string}`, b: unknown): boolean {
  if (typeof b !== "string" || b.length === 0) return false;
  const norm = (x: string) => {
    let s = x.toLowerCase();
    if (s.startsWith("0x")) s = s.slice(2);
    return `0x${s}`;
  };
  return norm(a) === norm(b);
}

/**
 * Validates the time window of an ERC-3009 `ReceiveWithAuthorization`.
 *
 * @param validAfter - Earliest unix timestamp the authorization is valid (in seconds).
 * @param validBefore - Latest unix timestamp before which the authorization is valid.
 * @returns An error code string if the time window is invalid, otherwise `undefined`.
 */
export function erc3009AuthorizationTimeInvalidReason(
  validAfter: bigint,
  validBefore: bigint,
): string | undefined {
  const now = Math.floor(Date.now() / 1000);
  if (validBefore < BigInt(now + 6)) return Errors.ErrValidBeforeExpired;
  if (validAfter > BigInt(now)) return Errors.ErrValidAfterInFuture;
  return undefined;
}

/**
 * Dual-path voucher signature verification.
 *
 * When `payerAuthorizer` is a non-zero address, the signature is verified off-chain via
 * ECDSA recovery against that address (no RPC call).  When `payerAuthorizer` is `address(0)`,
 * verification falls back to an ERC-1271 `isValidSignature` call against the payer contract
 * (smart-wallet path).
 *
 * @param signer - Facilitator signer providing `verifyTypedData` (may issue RPC for ERC-1271).
 * @param params - Voucher fields and authorizer addresses needed for verification.
 * @param params.channelId - EIP-712 voucher channel id (`bytes32` hex).
 * @param params.maxClaimableAmount - Max cumulative claimable amount as a decimal string.
 * @param params.payerAuthorizer - Address that signed the voucher; zero address selects ERC-1271 verification.
 * @param params.payer - Payer contract address (used for ERC-1271).
 * @param params.signature - EIP-712 signature bytes over the voucher.
 * @param chainId - Numeric EVM chain id for the EIP-712 domain.
 * @returns `true` when the voucher signature is valid.
 */
export async function verifyBatchSettlementVoucherTypedData(
  signer: FacilitatorEvmSigner,
  params: {
    channelId: `0x${string}`;
    maxClaimableAmount: string;
    payerAuthorizer: `0x${string}`;
    payer: `0x${string}`;
    signature: `0x${string}`;
  },
  chainId: number,
): Promise<boolean> {
  const domain = getBatchSettlementEip712Domain(chainId);
  const message = {
    channelId: params.channelId,
    maxClaimableAmount: BigInt(params.maxClaimableAmount),
  };

  const zeroAddress = "0x0000000000000000000000000000000000000000";

  if (params.payerAuthorizer !== zeroAddress) {
    // x402BatchSettlement uses ECDSA.recoverCalldata: pure ecrecover, no code check,
    // no EIP-1271. verifyECDSA matches that and never issues an RPC.
    if (!isContractRecoverableSignature(params.signature)) return false;
    try {
      const digest = hashTypedData({
        domain,
        types: voucherTypes,
        primaryType: "Voucher",
        message,
      });
      return await verifyECDSA(getAddress(params.payerAuthorizer), digest, params.signature);
    } catch {
      return false;
    }
  }

  // A zero payerAuthorizer uses SignatureChecker: ECDSA with no code, EIP-1271 with code (including 7702).
  // A payer with code never falls back to ECDSA.
  let digest: `0x${string}`;
  let code: `0x${string}` | undefined;
  try {
    digest = hashTypedData({ domain, types: voucherTypes, primaryType: "Voucher", message });
    code = await signer.getCode({ address: getAddress(params.payer) });
  } catch {
    return false;
  }
  if ((!code || code === "0x") && !isContractRecoverableSignature(params.signature)) {
    return false;
  }
  return verifyHashSignatureWithCode(
    signer,
    getAddress(params.payer),
    code,
    digest,
    params.signature,
  );
}

/**
 * Parses the server-supplied `requirements.amount` as a non-negative base-10 integer.
 *
 * The amount comes from the resource server, so the facilitator must not trust it: malformed or
 * negative values (which would lower the minimum-advance floor) are rejected instead of throwing.
 *
 * @param amount - The raw `requirements.amount` value.
 * @returns The parsed amount, or `undefined` when it is not a digits-only decimal string.
 */
export function parseRequirementsAmount(amount: unknown): bigint | undefined {
  return typeof amount === "string" && /^\d+$/.test(amount) ? BigInt(amount) : undefined;
}

/** {@link ChannelState} plus the pending withdrawal amount, which never goes on the wire. */
export type OnchainChannelState = ChannelState & { withdrawAmount: bigint };

/**
 * Reads onchain channel state via a 3-call multicall:
 * `channels(channelId)`, `pendingWithdrawals(channelId)`, `refundNonce(channelId)`.
 *
 * Throws when any sub-call fails so callers can distinguish RPC failures
 * from missing channels (which return zero balance/totalClaimed/refundNonce).
 *
 * @param signer - Facilitator signer for onchain reads.
 * @param channelId - The `bytes32` channel id.
 * @returns Fresh {@link OnchainChannelState}.
 */
export async function readChannelState(
  signer: FacilitatorEvmSigner,
  channelId: `0x${string}`,
): Promise<OnchainChannelState> {
  const target = getAddress(BATCH_SETTLEMENT_ADDRESS);
  const mcResults = await multicall(signer.readContract.bind(signer), [
    { address: target, abi: batchSettlementABI, functionName: "channels", args: [channelId] },
    {
      address: target,
      abi: batchSettlementABI,
      functionName: "pendingWithdrawals",
      args: [channelId],
    },
    { address: target, abi: batchSettlementABI, functionName: "refundNonce", args: [channelId] },
  ]);

  const [chRes, wdRes, rnRes] = mcResults;
  if (chRes.status === "failure" || wdRes.status === "failure" || rnRes.status === "failure") {
    throw new Error(`${Errors.ErrRpcReadFailed}: multicall returned failure for ${channelId}`);
  }

  const [balance, totalClaimed] = chRes.result as [bigint, bigint];
  const [withdrawAmount, wdInitiatedAt] = wdRes.result as [bigint, bigint];
  const refundNonce = rnRes.result as bigint;

  return {
    balance,
    totalClaimed,
    withdrawRequestedAt: Number(wdInitiatedAt),
    refundNonce,
    withdrawAmount,
  };
}

/**
 * Serializes channel state into the wire `channelState` shape.
 *
 * @param channelId - The `bytes32` channel id.
 * @param state - Channel state to serialize.
 * @returns Wire channel state with decimal-string amounts.
 */
export function toChannelStateExtra(channelId: `0x${string}`, state: ChannelState) {
  return {
    channelId,
    balance: state.balance.toString(),
    totalClaimed: state.totalClaimed.toString(),
    withdrawRequestedAt: state.withdrawRequestedAt,
    refundNonce: state.refundNonce.toString(),
  };
}

/**
 * Decodes the `eventName` logs the batch-settlement contract emitted for `channelId`.
 *
 * @param logs - Receipt logs.
 * @param eventName - Channel-scoped event to decode.
 * @param channelId - The `bytes32` channel id.
 * @returns Decoded events for the channel, in log order.
 */
export function findChannelEvents<TEventName extends "Deposited" | "Claimed" | "Refunded">(
  logs: readonly Log[],
  eventName: TEventName,
  channelId: `0x${string}`,
) {
  const contract = getAddress(BATCH_SETTLEMENT_ADDRESS);
  return parseEventLogs({
    abi: batchSettlementABI,
    eventName,
    logs: logs.filter(log => isAddressEqual(log.address, contract)),
  }).filter(log => channelIdsEqual(channelId, log.args.channelId));
}

/**
 * Builds the terminal failure for a successful receipt whose `logs` field is missing. An RPC
 * always returns `logs` (possibly empty), so a missing field means the signer dropped it.
 *
 * @param transaction - The confirmed transaction hash.
 * @param network - Network the transaction was broadcast to.
 * @param payer - The payer address.
 * @returns Failed settle response with reason {@link Errors.ErrReceiptLogsUnavailable}.
 */
export function receiptLogsUnavailableResponse(
  transaction: `0x${string}`,
  network: Network,
  payer: string | undefined,
): SettleResponse {
  return {
    success: false,
    errorReason: Errors.ErrReceiptLogsUnavailable,
    errorMessage:
      "signer returned a receipt without logs; batch settlement requires waitForTransactionReceipt to return receipt logs",
    transaction,
    network,
    payer,
  };
}
