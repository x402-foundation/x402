import { getAddress, verifyTypedData as viemVerifyTypedData } from "viem";
import type { PaymentRequirements } from "@x402/core/types";
import { FacilitatorEvmSigner } from "../../signer";
import { multicall } from "../../multicall";
import {
  BATCH_SETTLEMENT_ADDRESS,
  MIN_WITHDRAW_DELAY,
  MAX_WITHDRAW_DELAY,
  voucherTypes,
} from "../constants";
import { batchSettlementABI } from "../abi";
import type {
  BatchSettlementPaymentRequirementsExtra,
  ChannelConfig,
  ChannelState,
} from "../types";
import { computeChannelId, getBatchSettlementEip712Domain } from "../utils";
import * as Errors from "../errors";

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
    return viemVerifyTypedData({
      address: getAddress(params.payerAuthorizer),
      domain,
      types: voucherTypes,
      primaryType: "Voucher",
      message,
      signature: params.signature,
    });
  }

  return signer.verifyTypedData({
    address: getAddress(params.payer),
    domain,
    types: voucherTypes,
    primaryType: "Voucher",
    message,
    signature: params.signature,
  });
}

/**
 * Validates that a {@link ChannelConfig} is consistent with the claimed `channelId` and
 * the server's {@link PaymentRequirements}.
 *
 * @param config - The channel configuration from the payload.
 * @param channelId - The `channelId` claimed in the payload.
 * @param requirements - Server payment requirements to cross-check against.
 * @returns An error code string if validation fails, otherwise `undefined`.
 */
export function validateChannelConfig(
  config: ChannelConfig,
  channelId: `0x${string}`,
  requirements: PaymentRequirements,
): string | undefined {
  const computedId = computeChannelId(config, requirements.network);
  if (computedId.toLowerCase() !== channelId.toLowerCase()) {
    return Errors.ErrChannelIdMismatch;
  }

  if (getAddress(config.receiver) !== getAddress(requirements.payTo)) {
    return Errors.ErrReceiverMismatch;
  }

  const extra = requirements.extra as Partial<BatchSettlementPaymentRequirementsExtra> | undefined;
  const requiredReceiverAuthorizer = extra?.receiverAuthorizer;

  if (
    !requiredReceiverAuthorizer ||
    getAddress(requiredReceiverAuthorizer) === "0x0000000000000000000000000000000000000000" ||
    getAddress(config.receiverAuthorizer) !== getAddress(requiredReceiverAuthorizer)
  ) {
    return Errors.ErrReceiverAuthorizerMismatch;
  }

  if (getAddress(config.token) !== getAddress(requirements.asset)) {
    return Errors.ErrTokenMismatch;
  }

  if (extra?.withdrawDelay !== undefined && config.withdrawDelay !== Number(extra.withdrawDelay)) {
    return Errors.ErrWithdrawDelayMismatch;
  }

  if (config.withdrawDelay < MIN_WITHDRAW_DELAY || config.withdrawDelay > MAX_WITHDRAW_DELAY) {
    return Errors.ErrWithdrawDelayOutOfRange;
  }

  return undefined;
}

/**
 * Reads onchain channel state via a 3-call multicall:
 * `channels(channelId)`, `pendingWithdrawals(channelId)`, `refundNonce(channelId)`.
 *
 * Throws when any sub-call fails so callers can distinguish RPC failures
 * from missing channels (which return zero balance/totalClaimed/refundNonce).
 *
 * @param signer - Facilitator signer for onchain reads.
 * @param channelId - The `bytes32` channel id.
 * @returns Fresh {@link ChannelState}.
 */
export async function readChannelState(
  signer: FacilitatorEvmSigner,
  channelId: `0x${string}`,
): Promise<ChannelState> {
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
  const [, wdInitiatedAt] = wdRes.result as [bigint, bigint];
  const refundNonce = rnRes.result as bigint;

  return { balance, totalClaimed, withdrawRequestedAt: Number(wdInitiatedAt), refundNonce };
}
