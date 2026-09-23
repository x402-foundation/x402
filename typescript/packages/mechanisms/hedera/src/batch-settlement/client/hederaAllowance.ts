import type { PaymentRequirements, PaymentPayloadResult } from "@x402/core/types";
import { getAddress, toHex } from "viem";
import type { ClientHederaBatchSigner } from "../signer";
import { HTS_INT64_MAX, getBatchSettlementDeployment } from "../constants";
import { getHederaChainId } from "../addresses";
import { computeHederaAllowanceDepositDigest } from "../encoding";
import type { BatchSettlementDepositPayload, ChannelConfig } from "../types";
import { computeChannelId } from "../utils";
import * as Errors from "../errors";
import { signVoucher } from "./voucher";

/**
 * Creates a random 256-bit nonce for a deposit authorization.
 *
 * @returns Decimal string nonce.
 */
export function createDepositNonce(): string {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj) {
    throw new Error("Crypto API not available");
  }
  return BigInt(toHex(cryptoObj.getRandomValues(new Uint8Array(32)))).toString();
}

/**
 * Builds a batch deposit payload authorized through the payer's HTS allowance to the collector.
 *
 * The payer signs `computeHederaAllowanceDepositDigest(...)` (binding channel id, token, amount,
 * nonce, deadline, collector and chain id) with its Hedera account key, and a voucher for the
 * first request. The facilitator submits `deposit(config, amount, collector, collectorData)`; the
 * collector verifies the signature via the Hedera Account Service and pulls the tokens with the
 * HTS `transferFrom` system contract call.
 *
 * @param signer - Payer signer (the account that granted the allowance).
 * @param x402Version - Protocol version for the payment envelope.
 * @param paymentRequirements - Server-provided payment requirements.
 * @param channelConfig - Channel configuration bound into the voucher and authorization.
 * @param depositAmount - Token amount deposited into the channel (base units).
 * @param maxClaimableAmount - Cumulative amount signed in the voucher.
 * @param voucherSigner - Optional dedicated voucher signer (`payerAuthorizer`).
 * @returns Signed deposit payload and voucher.
 */
export async function createBatchSettlementHederaAllowanceDepositPayload(
  signer: ClientHederaBatchSigner,
  x402Version: number,
  paymentRequirements: PaymentRequirements,
  channelConfig: ChannelConfig,
  depositAmount: string,
  maxClaimableAmount: string,
  voucherSigner?: ClientHederaBatchSigner,
): Promise<PaymentPayloadResult> {
  if (!/^\d+$/.test(depositAmount) || BigInt(depositAmount) <= 0n) {
    throw new Error("depositAmount must be a positive integer string");
  }
  if (BigInt(depositAmount) > HTS_INT64_MAX) {
    throw new Error(Errors.ErrAmountExceedsInt64);
  }

  const network = paymentRequirements.network;
  const deployment = getBatchSettlementDeployment(network);
  const nonce = createDepositNonce();
  const deadline = Math.floor(Date.now() / 1000 + paymentRequirements.maxTimeoutSeconds).toString();
  const channelId = computeChannelId(channelConfig, network);

  const digest = computeHederaAllowanceDepositDigest({
    channelId,
    token: getAddress(channelConfig.token),
    amount: depositAmount,
    nonce,
    deadline,
    collector: getAddress(deployment.collector),
    chainId: getHederaChainId(network),
  });
  const signature = await signer.signDigest(digest);

  const voucher = await signVoucher(
    voucherSigner ?? signer,
    channelId,
    maxClaimableAmount,
    network,
  );

  const payload: BatchSettlementDepositPayload = {
    type: "deposit",
    channelConfig,
    voucher,
    deposit: {
      amount: depositAmount,
      authorization: {
        hederaAllowanceAuthorization: { nonce, deadline, signature },
      },
    },
  };

  return { x402Version, payload };
}
