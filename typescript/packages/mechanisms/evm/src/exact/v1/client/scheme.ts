import {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import { PaymentRequirementsV1 } from "@x402/core/types/v1";
import { getAddress } from "viem";
import { authorizationTypes } from "../../../constants";
import { ClientEvmSigner } from "../../../signer";
import { ExactEvmPayloadV1 } from "../../../types";
import { createNonce } from "../../../utils";
import { EvmNetworkV1, getEvmChainIdV1 } from "../../../v1";

/**
 * EVM client implementation for the Exact payment scheme (V1).
 */
export class ExactEvmSchemeV1 implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * Creates a new ExactEvmClientV1 instance.
   *
   * @param signer - The EVM signer for client operations
   */
  constructor(private readonly signer: ClientEvmSigner) {}

  /**
   * Creates a payment payload for the Exact scheme (V1).
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - The payment requirements
   * @returns Promise resolving to a payment payload
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<
    Pick<PaymentPayload, "x402Version" | "payload"> & { scheme: string; network: Network }
  > {
    const selectedV1 = paymentRequirements as unknown as PaymentRequirementsV1;
    const nonce = createNonce();
    const now = Math.floor(Date.now() / 1000);

    const authorization: ExactEvmPayloadV1["authorization"] = {
      from: this.signer.address,
      to: getAddress(selectedV1.payTo),
      value: selectedV1.maxAmountRequired,
      validAfter: (now - 600).toString(), // 10 minutes before
      validBefore: (now + selectedV1.maxTimeoutSeconds).toString(),
      nonce,
    };

    // Sign the authorization
    const signature = await this.signAuthorization(authorization, selectedV1);

    const payload: ExactEvmPayloadV1 = {
      authorization,
      signature,
    };

    return {
      x402Version,
      scheme: selectedV1.scheme,
      network: selectedV1.network,
      payload,
    };
  }

  /**
   * Sign the EIP-3009 authorization using EIP-712
   *
   * @param authorization - The authorization to sign
   * @param requirements - The payment requirements
   * @returns Promise resolving to the signature
   */
  private async signAuthorization(
    authorization: ExactEvmPayloadV1["authorization"],
    requirements: PaymentRequirementsV1,
  ): Promise<`0x${string}`> {
    const chainId = getEvmChainIdV1(requirements.network as EvmNetworkV1);

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

    return await this.signer.signTypedData({
      domain,
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message,
    });
  }
}
