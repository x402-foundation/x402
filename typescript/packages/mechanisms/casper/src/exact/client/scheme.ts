import type {
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import { SCHEME_EXACT } from "../../constants";
import type { ClientCasperSigner, ExactCasperAuthorization } from "../../types";
import {
  buildTransferWithAuthorizationDigest,
  bytesToHex,
  isValidCasperAddress,
  isValidContractPackageHash,
} from "../../utils";

/**
 * Casper client implementation for the exact payment scheme.
 */
export class ExactCasperScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME_EXACT;

  /**
   * Create a new exact Casper client scheme.
   *
   * @param signer - Casper client signer.
   */
  constructor(private readonly signer: ClientCasperSigner) {}

  /**
   * Create an exact Casper payment payload.
   *
   * @param x402Version - x402 protocol version.
   * @param paymentRequirements - Selected payment requirements.
   * @returns Payment payload result.
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    if (paymentRequirements.scheme !== SCHEME_EXACT) {
      throw new Error("invalid_exact_casper_client_invalid_scheme");
    }
    if (!isValidContractPackageHash(paymentRequirements.asset)) {
      throw new Error(`invalid_exact_casper_client_invalid_asset: ${paymentRequirements.asset}`);
    }
    if (!isValidCasperAddress(paymentRequirements.payTo)) {
      throw new Error(`invalid_exact_casper_client_invalid_pay_to: ${paymentRequirements.payTo}`);
    }

    const name = paymentRequirements.extra?.name;
    const version = paymentRequirements.extra?.version;
    if (typeof name !== "string" || name === "") {
      throw new Error("invalid_exact_casper_client_missing_token_name");
    }
    if (typeof version !== "string" || version === "") {
      throw new Error("invalid_exact_casper_client_missing_token_version");
    }

    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - 600;
    const validBefore = now + paymentRequirements.maxTimeoutSeconds;
    const nonce = crypto.getRandomValues(new Uint8Array(32));

    const authorization: ExactCasperAuthorization = {
      from: this.signer.accountAddress(),
      to: paymentRequirements.payTo,
      value: paymentRequirements.amount,
      validAfter: String(validAfter),
      validBefore: String(validBefore),
      nonce: bytesToHex(nonce),
    };

    let digest: Uint8Array;
    try {
      digest = buildTransferWithAuthorizationDigest({
        name,
        version,
        network: paymentRequirements.network,
        asset: paymentRequirements.asset,
        authorization,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid_exact_casper_client_failed_to_hash: ${message}`);
    }

    let signature: Uint8Array;
    try {
      signature = await this.signer.signEIP712(digest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid_exact_casper_client_failed_to_sign: ${message}`);
    }

    return {
      x402Version,
      payload: {
        signature: bytesToHex(signature),
        publicKey: this.signer.publicKey(),
        authorization,
      },
    };
  }
}
