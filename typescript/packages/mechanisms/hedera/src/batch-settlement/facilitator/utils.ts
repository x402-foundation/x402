import { getAddress, hashTypedData, isAddress } from "viem";
import type { PaymentRequirements } from "@x402/core/types";
import type { FacilitatorHederaBatchSigner } from "../signer";
import {
  MIN_WITHDRAW_DELAY,
  MAX_WITHDRAW_DELAY,
  getBatchSettlementDeployment,
  voucherTypes,
} from "../constants";
import { batchSettlementABI, erc20BalanceOfABI } from "../abi";
import type {
  BatchSettlementPaymentRequirementsExtra,
  ChannelConfig,
  ChannelState,
} from "../types";
import { computeChannelId, getBatchSettlementEip712Domain } from "../utils";
import { resolveReceiverAddress, resolveTokenAddress, resolveTokenId } from "../addresses";
import * as Errors from "../errors";

export { resolveReceiverAddress, resolveTokenAddress, resolveTokenId };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Normalises a {@link ChannelConfig} into the checksummed-address tuple expected by the
 * escrow contract's `deposit` / `refundWithSignature` / `claimWithSignature` calls.
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

/** Outcome of an off-chain raw-signature check. */
export type SignatureCheck = { ok: boolean; reason?: string; message?: string };

/**
 * Verifies a voucher signature off-chain the way the escrow contract does on-chain: the digest is
 * the EIP-712 `Voucher` hash and the signer is `payerAuthorizer` when set, else `payer`.
 * Both are Hedera accounts; ED25519 and ECDSA keys are accepted.
 *
 * @param signer - Facilitator signer providing account-key resolution.
 * @param params - Voucher fields and channel signer addresses.
 * @param params.channelId - EIP-712 voucher channel id (`bytes32` hex).
 * @param params.maxClaimableAmount - Max cumulative claimable amount as a decimal string.
 * @param params.payerAuthorizer - Committed voucher signer, or the zero address.
 * @param params.payer - Payer account EVM address (signer when `payerAuthorizer` is zero).
 * @param params.signature - Raw account signature over the voucher digest.
 * @param network - CAIP-2 Hedera network.
 * @returns Signature check outcome.
 */
export async function verifyVoucherSignature(
  signer: FacilitatorHederaBatchSigner,
  params: {
    channelId: `0x${string}`;
    maxClaimableAmount: string;
    payerAuthorizer: `0x${string}`;
    payer: `0x${string}`;
    signature: `0x${string}`;
  },
  network: string,
): Promise<SignatureCheck> {
  try {
    const digest = hashTypedData({
      domain: getBatchSettlementEip712Domain(network),
      types: voucherTypes,
      primaryType: "Voucher",
      message: {
        channelId: params.channelId,
        maxClaimableAmount: BigInt(params.maxClaimableAmount),
      },
    });
    const account =
      getAddress(params.payerAuthorizer) !== ZERO_ADDRESS
        ? getAddress(params.payerAuthorizer)
        : getAddress(params.payer);
    return await signer.verifyDigestSignature({ account, digest, signature: params.signature });
  } catch (error) {
    return {
      ok: false,
      reason: "signature_invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Maps a failed {@link SignatureCheck} to the scheme's error code.
 *
 * @param check - Failed signature check.
 * @param fallback - Error code for a plain invalid signature.
 * @returns Error code.
 */
export function signatureCheckErrorCode(check: SignatureCheck, fallback: string): string {
  switch (check.reason) {
    case "unsupported_key":
      return Errors.ErrUnsupportedAccountKey;
    case "account_not_found":
      return Errors.ErrPayerAccountNotFound;
    case "resolution_failed":
      return Errors.ErrRpcReadFailed;
    default:
      return fallback;
  }
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
  let computedId: `0x${string}`;
  try {
    computedId = computeChannelId(config, requirements.network);
  } catch {
    return Errors.ErrNetworkMismatch;
  }
  if (computedId.toLowerCase() !== channelId.toLowerCase()) {
    return Errors.ErrChannelIdMismatch;
  }

  const receiver = resolveReceiverAddress(requirements.payTo);
  if (!receiver || getAddress(config.receiver) !== receiver) {
    return Errors.ErrReceiverMismatch;
  }

  const extra = requirements.extra as Partial<BatchSettlementPaymentRequirementsExtra> | undefined;
  const requiredReceiverAuthorizer = extra?.receiverAuthorizer;

  if (
    !requiredReceiverAuthorizer ||
    !isAddress(requiredReceiverAuthorizer) ||
    getAddress(requiredReceiverAuthorizer) === ZERO_ADDRESS ||
    getAddress(config.receiverAuthorizer) !== getAddress(requiredReceiverAuthorizer)
  ) {
    return Errors.ErrReceiverAuthorizerMismatch;
  }

  const token = resolveTokenAddress(requirements.asset);
  if (!token || getAddress(config.token) !== token) {
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
 * Reads onchain channel state (`channels`, `pendingWithdrawals`, `refundNonce`) from the
 * escrow deployed on `network`. Throws when any read fails so callers can distinguish RPC
 * failures from missing channels (which return zero balance/totalClaimed/refundNonce).
 *
 * @param signer - Facilitator signer for onchain reads.
 * @param channelId - The `bytes32` channel id.
 * @param network - CAIP-2 Hedera network.
 * @returns Fresh {@link ChannelState}.
 */
export async function readChannelState(
  signer: FacilitatorHederaBatchSigner,
  channelId: `0x${string}`,
  network: string,
): Promise<ChannelState> {
  const target = getAddress(getBatchSettlementDeployment(network).settlement);
  try {
    const [channel, withdrawal, refundNonce] = await Promise.all([
      signer.readContract({
        address: target,
        abi: batchSettlementABI,
        functionName: "channels",
        args: [channelId],
      }) as Promise<readonly [bigint, bigint]>,
      signer.readContract({
        address: target,
        abi: batchSettlementABI,
        functionName: "pendingWithdrawals",
        args: [channelId],
      }) as Promise<readonly [bigint, bigint]>,
      signer.readContract({
        address: target,
        abi: batchSettlementABI,
        functionName: "refundNonce",
        args: [channelId],
      }) as Promise<bigint>,
    ]);
    const [balance, totalClaimed] = channel;
    const [, wdInitiatedAt] = withdrawal;
    return { balance, totalClaimed, withdrawRequestedAt: Number(wdInitiatedAt), refundNonce };
  } catch (error) {
    throw new Error(
      `${Errors.ErrRpcReadFailed}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Reads the payer's HTS token balance through the token's ERC-20 facade.
 *
 * @param signer - Facilitator signer for onchain reads.
 * @param token - Token EVM address.
 * @param account - Account EVM address.
 * @returns Balance in token base units.
 */
export async function readTokenBalance(
  signer: FacilitatorHederaBatchSigner,
  token: `0x${string}`,
  account: `0x${string}`,
): Promise<bigint> {
  return (await signer.readContract({
    address: getAddress(token),
    abi: erc20BalanceOfABI,
    functionName: "balanceOf",
    args: [getAddress(account)],
  })) as bigint;
}
