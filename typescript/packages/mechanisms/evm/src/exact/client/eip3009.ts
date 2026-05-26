import { PaymentRequirements, PaymentPayloadResult } from "@x402/core/types";
import { getAddress } from "viem";
import { authorizationTypes } from "../../constants";
import { ClientEvmSigner } from "../../signer";
import { ExactEIP3009Payload } from "../../types";
import { createNonce, getEvmChainId } from "../../utils";

/**
 * Creates an EIP-3009 (transferWithAuthorization) payload.
 *
 * @param signer - The EVM signer for client operations
 * @param x402Version - The x402 protocol version
 * @param paymentRequirements - The payment requirements
 * @returns Promise resolving to a payment payload result
 */
export async function createEIP3009Payload(
  signer: ClientEvmSigner,
  x402Version: number,
  paymentRequirements: PaymentRequirements,
): Promise<PaymentPayloadResult> {
  const nonce = createNonce();
  const now = Math.floor(Date.now() / 1000);

  const authorization: ExactEIP3009Payload["authorization"] = {
    from: signer.address,
    to: getAddress(paymentRequirements.payTo),
    value: paymentRequirements.amount,
    validAfter: (now - 600).toString(),
    validBefore: (now + paymentRequirements.maxTimeoutSeconds).toString(),
    nonce,
  };

  const signature = await signEIP3009Authorization(signer, authorization, paymentRequirements);

  const payload: ExactEIP3009Payload = {
    authorization,
    signature,
  };

  return {
    x402Version,
    payload,
  };
}

/**
 * Sign the EIP-3009 authorization using EIP-712.
 *
 * @param signer - The EVM signer
 * @param authorization - The authorization to sign
 * @param requirements - The payment requirements
 * @returns Promise resolving to the signature
 */
async function signEIP3009Authorization(
  signer: ClientEvmSigner,
  authorization: ExactEIP3009Payload["authorization"],
  requirements: PaymentRequirements,
): Promise<`0x${string}`> {
  const chainId = getEvmChainId(requirements.network);

  if (!requirements.extra?.name || !requirements.extra?.version) {
    throw new Error(
      `EIP-712 domain parameters (name, version) are required in payment requirements for asset ${requirements.asset}`,
    );
  }

  const { name, version } = requirements.extra;

  const domain = {
    name,
    version,
    chainId,
    verifyingContract: getAddress(requirements.asset),
  };

  const message = {
    from: getAddress(authorization.from),
    to: getAddress(authorization.to),
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  };

  return await signer.signTypedData({
    domain,
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message,
  });
}
