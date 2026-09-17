import type { PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { getAddress } from "viem";
import type { FacilitatorHederaBatchSigner } from "../signer";
import { hederaAllowanceDepositCollectorABI } from "../abi";
import { HTS_INT64_MAX, getBatchSettlementDeployment } from "../constants";
import { getHederaChainId } from "../addresses";
import {
  buildHederaAllowanceCollectorData,
  computeHederaAllowanceDepositDigest,
} from "../encoding";
import type { BatchSettlementDepositPayload } from "../types";
import * as Errors from "../errors";
import { resolveTokenId, signatureCheckErrorCode } from "./utils";

/**
 * Returns the deposit collector used for HTS-allowance deposits on `network`.
 *
 * @param network - CAIP-2 Hedera network.
 * @returns Collector contract address.
 */
export function getHederaAllowanceCollectorAddress(network: string): `0x${string}` {
  return getAddress(getBatchSettlementDeployment(network).collector);
}

/**
 * Encodes collector data for an HTS-allowance deposit payload.
 *
 * @param payload - Deposit payload containing the allowance authorization.
 * @returns ABI-encoded collector data.
 */
export function buildHederaAllowanceDepositCollectorData(
  payload: BatchSettlementDepositPayload,
): `0x${string}` {
  const auth = payload.deposit.authorization.hederaAllowanceAuthorization;
  if (!auth) {
    throw new Error(Errors.ErrAllowanceAuthorizationRequired);
  }
  return buildHederaAllowanceCollectorData(auth.nonce, auth.deadline, auth.signature);
}

/**
 * Verifies the payer's HTS-allowance deposit authorization: field presence, deadline, unused
 * nonce, raw account signature over the deposit digest, int64 bounds, and that the payer granted
 * the collector an allowance covering the deposit.
 *
 * @param signer - Facilitator signer for reads, signature verification and Mirror Node access.
 * @param payload - Batch deposit payload.
 * @param requirements - Payment requirements for the request.
 * @returns A failure response, or `null` when valid.
 */
export async function verifyHederaAllowanceAuthorization(
  signer: FacilitatorHederaBatchSigner,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
): Promise<VerifyResponse | null> {
  const payer = payload.channelConfig.payer;
  const network = requirements.network;
  const auth = payload.deposit.authorization.hederaAllowanceAuthorization;

  if (
    !auth ||
    typeof auth.nonce !== "string" ||
    typeof auth.deadline !== "string" ||
    typeof auth.signature !== "string" ||
    !/^\d+$/.test(auth.nonce) ||
    !/^\d+$/.test(auth.deadline) ||
    !/^0x[0-9a-fA-F]+$/.test(auth.signature)
  ) {
    return { isValid: false, invalidReason: Errors.ErrAllowanceAuthorizationRequired, payer };
  }

  if (!/^\d+$/.test(payload.deposit.amount)) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadType, payer };
  }
  const amount = BigInt(payload.deposit.amount);
  if (amount <= 0n || amount > HTS_INT64_MAX) {
    return { isValid: false, invalidReason: Errors.ErrAmountExceedsInt64, payer };
  }

  const now = Math.floor(Date.now() / 1000);
  if (BigInt(auth.deadline) < BigInt(now + 6)) {
    return { isValid: false, invalidReason: Errors.ErrAllowanceDeadlineExpired, payer };
  }

  const collector = getHederaAllowanceCollectorAddress(network);

  try {
    const used = (await signer.readContract({
      address: collector,
      abi: hederaAllowanceDepositCollectorABI,
      functionName: "usedNonces",
      args: [getAddress(payer), BigInt(auth.nonce)],
    })) as boolean;
    if (used) {
      return { isValid: false, invalidReason: Errors.ErrAllowanceNonceUsed, payer };
    }
  } catch (error) {
    return {
      isValid: false,
      invalidReason: Errors.ErrRpcReadFailed,
      invalidMessage: error instanceof Error ? error.message : String(error),
      payer,
    };
  }

  const digest = computeHederaAllowanceDepositDigest({
    channelId: payload.voucher.channelId,
    token: payload.channelConfig.token,
    amount: payload.deposit.amount,
    nonce: auth.nonce,
    deadline: auth.deadline,
    collector,
    chainId: getHederaChainId(network),
  });
  const sigCheck = await signer.verifyDigestSignature({
    account: getAddress(payer),
    digest,
    signature: auth.signature,
  });
  if (!sigCheck.ok) {
    return {
      isValid: false,
      invalidReason: signatureCheckErrorCode(sigCheck, Errors.ErrAllowanceSignatureInvalid),
      invalidMessage: sigCheck.message,
      payer,
    };
  }

  const tokenId = resolveTokenId(requirements.asset) ?? resolveTokenId(payload.channelConfig.token);
  if (!tokenId) {
    return { isValid: false, invalidReason: Errors.ErrTokenMismatch, payer };
  }
  try {
    const allowance = await signer.mirror.getTokenAllowance(
      payer,
      getBatchSettlementDeployment(network).collectorId,
      tokenId,
    );
    if (allowance < amount) {
      return {
        isValid: false,
        invalidReason: Errors.ErrAllowanceInsufficient,
        invalidMessage: `payer allowance to collector is ${allowance}, deposit needs ${amount}`,
        payer,
      };
    }
  } catch (error) {
    return {
      isValid: false,
      invalidReason: Errors.ErrRpcReadFailed,
      invalidMessage: error instanceof Error ? error.message : String(error),
      payer,
    };
  }

  return null;
}
