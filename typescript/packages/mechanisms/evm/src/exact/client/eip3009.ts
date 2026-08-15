import { PaymentRequirements, PaymentPayloadResult } from "@x402/core/types";
import { getAddress } from "viem";
import { authorizationTypes } from "../../constants";
import { ClientEvmSigner } from "../../signer";
import { ExactEIP3009Payload } from "../../types";
import { createNonce, getEvmChainId } from "../../utils";

/**
 * Validates a seller-supplied extra.verifyingContract before it is trusted for EIP-712 signing.
 *
 * @param candidate - The address from requirements.extra.verifyingContract
 * @param requirements - The full payment requirements, for context (e.g. network)
 * @returns True to sign against `candidate`. False to fall back to requirements.asset, same as
 *   if no verifyingContract were supplied.
 */
export type VerifyingContractValidator = (
  candidate: string,
  requirements: PaymentRequirements,
) => boolean;

/**
 * Resolve the EIP-712 verifyingContract for signing. Defaults to requirements.asset. Only trusts
 * a seller-supplied extra.verifyingContract if a validator was supplied and it approves this
 * specific candidate.
 *
 * @param requirements - The payment requirements
 * @param validator - Optional validator to trust extra.verifyingContract
 * @returns The address to use as the EIP-712 domain's verifyingContract
 */
function resolveVerifyingContract(
  requirements: PaymentRequirements,
  validator?: VerifyingContractValidator,
): `0x${string}` {
  const candidate = requirements.extra?.verifyingContract as string | undefined;
  if (!candidate || !validator || !validator(candidate, requirements)) {
    return getAddress(requirements.asset);
  }
  return getAddress(candidate);
}

/**
 * Creates an EIP-3009 (transferWithAuthorization) payload.
 *
 * @param signer - The EVM signer for client operations
 * @param x402Version - The x402 protocol version
 * @param paymentRequirements - The payment requirements
 * @param verifyingContractValidator - Optional callback to trust a seller-supplied
 *   extra.verifyingContract (e.g. Circle Gateway's batch-settlement contract) instead of
 *   requirements.asset. If not provided, extra.verifyingContract is never trusted.
 * @returns Promise resolving to a payment payload result
 */
export async function createEIP3009Payload(
  signer: ClientEvmSigner,
  x402Version: number,
  paymentRequirements: PaymentRequirements,
  verifyingContractValidator?: VerifyingContractValidator,
): Promise<PaymentPayloadResult> {
  const nonce = createNonce();
  const now = Math.floor(Date.now() / 1000);

  const authorization: ExactEIP3009Payload["authorization"] = {
    from: signer.address,
    to: getAddress(paymentRequirements.payTo),
    value: paymentRequirements.amount,
    validAfter: "0",
    validBefore: (now + paymentRequirements.maxTimeoutSeconds).toString(),
    nonce,
  };

  const signature = await signEIP3009Authorization(
    signer,
    authorization,
    paymentRequirements,
    verifyingContractValidator,
  );

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
 * @param verifyingContractValidator - Optional callback to trust extra.verifyingContract
 * @returns Promise resolving to the signature
 */
async function signEIP3009Authorization(
  signer: ClientEvmSigner,
  authorization: ExactEIP3009Payload["authorization"],
  requirements: PaymentRequirements,
  verifyingContractValidator?: VerifyingContractValidator,
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
    verifyingContract: resolveVerifyingContract(requirements, verifyingContractValidator),
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
