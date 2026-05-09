import { PaymentRequirements, PaymentPayloadResult } from "@x402/core/types";
import {
  PERMIT2_ADDRESS,
  uptoPermit2WitnessTypes,
  x402UptoPermit2ProxyAddress,
} from "../../constants";
import { ClientEvmSigner } from "../../signer";
import { UptoPermit2Authorization } from "../../types";
import { createPermit2Nonce, getEvmChainId } from "../../utils";
import { getAddress } from "viem";

// Re-export Permit2-generic approval helpers
export { createPermit2ApprovalTx, getPermit2AllowanceReadParams } from "../../exact/client/permit2";
export type { Permit2AllowanceParams } from "../../exact/client/permit2";

/**
 * Creates a signed upto Permit2 payment payload for the given requirements.
 *
 * Constructs a Permit2 authorization with an upto witness (including facilitator address)
 * and signs it using EIP-712 typed data.
 *
 * @param signer - The EVM client signer for signing typed data
 * @param x402Version - The x402 protocol version
 * @param paymentRequirements - The payment requirements including asset, amount, and payTo
 * @returns Promise resolving to a payment payload result with the signed authorization
 */
export async function createUptoPermit2Payload(
  signer: ClientEvmSigner,
  x402Version: number,
  paymentRequirements: PaymentRequirements,
): Promise<PaymentPayloadResult> {
  const facilitatorAddress = paymentRequirements.extra?.facilitatorAddress as
    | `0x${string}`
    | undefined;
  if (!facilitatorAddress) {
    throw new Error(
      "upto scheme requires facilitatorAddress in paymentRequirements.extra. " +
        "Ensure the server is configured with an upto facilitator that provides getExtra().",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const nonce = createPermit2Nonce();
  const validAfter = (now - 600).toString();
  const deadline = (now + paymentRequirements.maxTimeoutSeconds).toString();

  if (BigInt(deadline) <= BigInt(validAfter)) {
    throw new Error(
      `Invalid time window: deadline (${deadline}) must be after validAfter (${validAfter}). ` +
        `Check that maxTimeoutSeconds (${paymentRequirements.maxTimeoutSeconds}) is positive.`,
    );
  }

  const permit2Authorization: UptoPermit2Authorization & { from: `0x${string}` } = {
    from: signer.address,
    permitted: {
      token: getAddress(paymentRequirements.asset),
      amount: paymentRequirements.amount,
    },
    spender: x402UptoPermit2ProxyAddress,
    nonce,
    deadline,
    witness: {
      to: getAddress(paymentRequirements.payTo),
      facilitator: getAddress(facilitatorAddress),
      validAfter,
    },
  };

  const chainId = getEvmChainId(paymentRequirements.network);

  const signature = await signer.signTypedData({
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS },
    types: uptoPermit2WitnessTypes,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: {
        token: getAddress(permit2Authorization.permitted.token),
        amount: BigInt(permit2Authorization.permitted.amount),
      },
      spender: getAddress(permit2Authorization.spender),
      nonce: BigInt(permit2Authorization.nonce),
      deadline: BigInt(permit2Authorization.deadline),
      witness: {
        to: getAddress(permit2Authorization.witness.to),
        facilitator: getAddress(permit2Authorization.witness.facilitator),
        validAfter: BigInt(permit2Authorization.witness.validAfter),
      },
    },
  });

  return {
    x402Version,
    payload: { signature, permit2Authorization },
  };
}
