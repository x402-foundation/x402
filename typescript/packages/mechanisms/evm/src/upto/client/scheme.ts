import {
  SchemeNetworkClient,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "@x402/core/types";
import { ClientEvmSigner } from "../../signer";
import { createUptoPermit2Payload } from "./permit2";
import {
  trySignEip2612PermitExtension,
  trySignErc20ApprovalExtension,
} from "../../shared/extensions";
import { UptoEvmSchemeOptions } from "./rpc";

/**
 * EVM client implementation for the Upto payment scheme.
 * Handles Permit2-based payment payload creation and gas-sponsoring extensions.
 */
export class UptoEvmScheme implements SchemeNetworkClient {
  readonly scheme = "upto";

  /**
   * Creates a new UptoEvmScheme instance.
   *
   * @param signer - The EVM signer for client operations
   * @param options - Optional RPC configuration
   */
  constructor(
    private readonly signer: ClientEvmSigner,
    private readonly options?: UptoEvmSchemeOptions,
  ) {}

  /**
   * Creates a payment payload for the Upto scheme using Permit2.
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - The payment requirements
   * @param context - Optional context with server-declared extensions
   * @returns Promise resolving to a payment payload result
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const result = await createUptoPermit2Payload(this.signer, x402Version, paymentRequirements);

    const eip2612Extensions = await trySignEip2612PermitExtension(
      this.signer,
      this.options,
      paymentRequirements,
      result,
      context,
    );
    if (eip2612Extensions) {
      return { ...result, extensions: eip2612Extensions };
    }

    const erc20Extensions = await trySignErc20ApprovalExtension(
      this.signer,
      this.options,
      paymentRequirements,
      context,
    );
    if (erc20Extensions) {
      return { ...result, extensions: erc20Extensions };
    }

    return result;
  }
}
