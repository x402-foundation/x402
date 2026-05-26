import { SettleResponse, PaymentRequirements } from "@x402/core/types";
import { getAddress } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import type { AuthorizerSigner, BatchSettlementClaimPayload } from "../types";
import { batchSettlementABI } from "../abi";
import { BATCH_SETTLEMENT_ADDRESS } from "../constants";
import { signClaimBatch } from "../authorizerSigner";
import * as Errors from "../errors";
import { toContractChannelConfig } from "./utils";

/**
 * Converts an array of {@link BatchSettlementVoucherClaim} into the onchain tuple format
 * expected by the contract's `claimWithSignature()` function.
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
 * Submits a batch claim via `claimWithSignature()`.
 *
 * When `claimAuthorizerSignature` is present in the payload it is used directly.
 * When absent the facilitator signs the `ClaimBatch` EIP-712 digest using
 * `authorizerSigner`, after verifying that every claim's `receiverAuthorizer`
 * matches `authorizerSigner.address`.
 *
 * @param signer - Facilitator signer used to submit the claim transaction.
 * @param payload - Claim payload containing voucher claims and optional authorizer signature.
 * @param requirements - Payment requirements for network identification.
 * @param authorizerSigner - Dedicated key for producing `ClaimBatch` EIP-712 signatures.
 * @returns A {@link SettleResponse} with the transaction hash on success.
 */
export async function executeClaimWithSignature(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementClaimPayload,
  requirements: PaymentRequirements,
  authorizerSigner: AuthorizerSigner,
): Promise<SettleResponse> {
  const network = requirements.network;
  const claimArgs = buildVoucherClaimArgs(payload.claims);

  let sig = payload.claimAuthorizerSignature;

  if (!sig) {
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

  try {
    await signer.readContract({
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "claimWithSignature",
      args: [claimArgs, sig],
    });
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrClaimSimulationFailed,
      errorMessage: e instanceof Error ? e.message : String(e),
      transaction: "",
      network,
    };
  }

  try {
    const tx = await signer.writeContract({
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "claimWithSignature",
      args: [claimArgs, sig],
    });

    const receipt = await signer.waitForTransactionReceipt({ hash: tx });

    if (receipt.status !== "success") {
      return {
        success: false,
        errorReason: Errors.ErrClaimTransactionFailed,
        errorMessage: `transaction reverted (receipt status ${receipt.status})`,
        transaction: tx,
        network,
      };
    }

    return {
      success: true,
      transaction: tx,
      network,
      amount: "",
    };
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrClaimTransactionFailed,
      errorMessage: e instanceof Error ? e.message : String(e),
      transaction: "",
      network,
    };
  }
}
