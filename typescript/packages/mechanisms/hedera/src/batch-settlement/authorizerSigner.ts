import { hashTypedData } from "viem";
import type { AuthorizerSigner, BatchSettlementVoucherClaim } from "./types";
import { claimBatchTypes, refundTypes } from "./constants";
import { computeChannelId, getBatchSettlementEip712Domain } from "./utils";

/**
 * Signs a `ClaimBatch` EIP-712 digest for `claimWithSignature()` with the receiver-authorizer key.
 *
 * @param signer - Authorizer signer holding the `receiverAuthorizer` account key.
 * @param claims - Voucher claims to include in the batch.
 * @param network - CAIP-2 Hedera network identifier.
 * @returns Raw account signature over `ClaimBatch(ClaimEntry[] claims)`.
 */
export async function signClaimBatch(
  signer: AuthorizerSigner,
  claims: BatchSettlementVoucherClaim[],
  network: string,
): Promise<`0x${string}`> {
  const claimEntries = claims.map(c => ({
    channelId: computeChannelId(c.voucher.channel, network),
    maxClaimableAmount: BigInt(c.voucher.maxClaimableAmount),
    totalClaimed: BigInt(c.totalClaimed),
  }));

  const digest = hashTypedData({
    domain: getBatchSettlementEip712Domain(network),
    types: claimBatchTypes,
    primaryType: "ClaimBatch",
    message: { claims: claimEntries },
  });
  return signer.signDigest(digest);
}

/**
 * Signs a `Refund` EIP-712 digest for `refundWithSignature()` with the receiver-authorizer key.
 *
 * @param signer - Authorizer signer holding the `receiverAuthorizer` account key.
 * @param channelId - Channel to authorize refund for.
 * @param amount - Refund amount (capped to unclaimed escrow onchain).
 * @param nonce - Must match onchain `refundNonce(channelId)`.
 * @param network - CAIP-2 Hedera network identifier.
 * @returns Raw account signature over `Refund(channelId, nonce, amount)`.
 */
export async function signRefund(
  signer: AuthorizerSigner,
  channelId: `0x${string}`,
  amount: string,
  nonce: string,
  network: string,
): Promise<`0x${string}`> {
  const digest = hashTypedData({
    domain: getBatchSettlementEip712Domain(network),
    types: refundTypes,
    primaryType: "Refund",
    message: { channelId, nonce: BigInt(nonce), amount: BigInt(amount) },
  });
  return signer.signDigest(digest);
}
