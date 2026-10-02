import type { SettleResponse, PaymentRequirements } from "@x402/core/types";
import { getAddress } from "viem";
import type { FacilitatorHederaBatchSigner } from "../signer";
import type { AuthorizerSigner, BatchSettlementClaimPayload } from "../types";
import { batchSettlementABI } from "../abi";
import { HEDERA_GAS, getBatchSettlementDeployment } from "../constants";
import { signClaimBatch } from "../authorizerSigner";
import * as Errors from "../errors";
import { runContractSettlement, truncate } from "../transport";
import { toContractChannelConfig } from "./utils";

/** Options for claim execution. */
export type ClaimExecutionOptions = {
  simulateBeforeSend?: boolean;
  /** Gas limit override; defaults to `claimBase + claimPerVoucher × n`. */
  gas?: bigint;
};

/**
 * Converts voucher claims into the onchain tuple format expected by `claimWithSignature()`.
 *
 * @param claims - Typed voucher claims with channel config, amounts, and signatures.
 * @returns Contract-ready VoucherClaim argument array.
 */
export function buildVoucherClaimArgs(claims: BatchSettlementClaimPayload["claims"]) {
  return claims.map(c => ({
    voucher: {
      channel: toContractChannelConfig(c.voucher.channel),
      maxClaimableAmount: BigInt(c.voucher.maxClaimableAmount),
    },
    signature: c.signature,
    totalClaimed: BigInt(c.totalClaimed),
  }));
}

/**
 * Default gas for a claim batch of `n` vouchers.
 *
 * @param n - Number of vouchers in the batch.
 * @returns Gas limit.
 */
export function claimGasFor(n: number): bigint {
  return HEDERA_GAS.claimBase + HEDERA_GAS.claimPerVoucher * BigInt(n);
}

/**
 * Submits a batch claim via `claimWithSignature()`.
 *
 * When `claimAuthorizerSignature` is present in the payload it is used directly. When absent the
 * facilitator signs the `ClaimBatch` digest with `authorizerSigner`, after verifying that every
 * claim's `receiverAuthorizer` matches `authorizerSigner.address`.
 *
 * @param signer - Facilitator signer used to submit the claim transaction.
 * @param payload - Claim payload containing voucher claims and optional authorizer signature.
 * @param requirements - Payment requirements for network identification.
 * @param authorizerSigner - Optional dedicated key for producing `ClaimBatch` signatures.
 * @param options - Simulation / gas options.
 * @returns A {@link SettleResponse} with the transaction id on success.
 */
export async function executeClaimWithSignature(
  signer: FacilitatorHederaBatchSigner,
  payload: BatchSettlementClaimPayload,
  requirements: PaymentRequirements,
  authorizerSigner: AuthorizerSigner | undefined,
  options: ClaimExecutionOptions = {},
): Promise<SettleResponse> {
  const network = requirements.network;
  if (!Array.isArray(payload.claims) || payload.claims.length === 0) {
    return { success: false, errorReason: Errors.ErrInvalidPayloadType, transaction: "", network };
  }
  const claimArgs = buildVoucherClaimArgs(payload.claims);
  const contractAddr = getAddress(getBatchSettlementDeployment(network).settlement);

  let sig = payload.claimAuthorizerSignature;

  if (!sig) {
    if (!authorizerSigner) {
      return {
        success: false,
        errorReason: Errors.ErrAuthorizerNotConfigured,
        transaction: "",
        network,
      };
    }
    for (const claim of payload.claims) {
      if (
        getAddress(claim.voucher.channel.receiverAuthorizer) !==
        getAddress(authorizerSigner.address)
      ) {
        return {
          success: false,
          errorReason: Errors.ErrAuthorizerAddressMismatch,
          transaction: "",
          network,
        };
      }
    }
    sig = await signClaimBatch(authorizerSigner, payload.claims, network);
  }

  if (options.simulateBeforeSend ?? true) {
    try {
      await signer.simulateContract({
        address: contractAddr,
        abi: batchSettlementABI,
        functionName: "claimWithSignature",
        args: [claimArgs, sig],
      });
    } catch (e) {
      return {
        success: false,
        errorReason: Errors.ErrClaimSimulationFailed,
        errorMessage: truncate(e instanceof Error ? e.message : String(e)),
        transaction: "",
        network,
      };
    }
  }

  return runContractSettlement(
    () =>
      signer.executeContract({
        address: contractAddr,
        abi: batchSettlementABI,
        functionName: "claimWithSignature",
        args: [claimArgs, sig],
        gas: options.gas ?? claimGasFor(payload.claims.length),
      }),
    network,
    undefined,
    { failedStatusReason: Errors.ErrClaimTransactionFailed },
  );
}
