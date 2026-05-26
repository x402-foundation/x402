import {
  SchemeNetworkClient,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "@x402/core/types";
import { ClientEvmSigner } from "../../signer";
import { AssetTransferMethod } from "../../types";
import { createEIP3009Payload } from "./eip3009";
import { createPermit2Payload } from "./permit2";
import {
  trySignEip2612PermitExtension,
  trySignErc20ApprovalExtension,
} from "../../shared/extensions";
import { ExactEvmSchemeOptions } from "./rpc";

/**
 * EVM client implementation for the Exact payment scheme.
 * Supports both EIP-3009 (transferWithAuthorization) and Permit2 flows.
 *
 * Routes to the appropriate authorization method based on
 * `requirements.extra.assetTransferMethod`. Defaults to EIP-3009
 * for backward compatibility with older facilitators.
 *
 * When the server advertises `eip2612GasSponsoring` and the asset transfer
 * method is `permit2`, the scheme automatically signs an EIP-2612 permit
 * if the user lacks Permit2 approval. This requires `readContract` on the signer.
 */
export class ExactEvmScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * Creates a new ExactEvmClient instance.
   *
   * @param signer - The EVM signer for client operations.
   *   Base flow only requires `address` + `signTypedData`.
   *   Extension enrichment (EIP-2612 / ERC-20 approval sponsoring) additionally
   *   requires optional capabilities like `readContract` and tx signing helpers.
   * @param options - Optional RPC configuration used to backfill extension capabilities.
   */
  constructor(
    private readonly signer: ClientEvmSigner,
    private readonly options?: ExactEvmSchemeOptions,
  ) {}

  /**
   * Creates a payment payload for the Exact scheme.
   * Routes to EIP-3009 or Permit2 based on requirements.extra.assetTransferMethod.
   *
   * For Permit2 flows, if the server advertises `eip2612GasSponsoring` and the
   * signer supports `readContract`, automatically signs an EIP-2612 permit
   * when Permit2 allowance is insufficient.
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - The payment requirements
   * @param context - Optional context with server-declared extensions
   * @returns Promise resolving to a payment payload result (with optional extensions)
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const assetTransferMethod =
      (paymentRequirements.extra?.assetTransferMethod as AssetTransferMethod) ?? "eip3009";

    if (assetTransferMethod === "permit2") {
      const result = await createPermit2Payload(this.signer, x402Version, paymentRequirements);

      const eip2612Extensions = await trySignEip2612PermitExtension(
        this.signer,
        this.options,
        paymentRequirements,
        result,
        context,
      );

      if (eip2612Extensions) {
        return {
          ...result,
          extensions: eip2612Extensions,
        };
      }

      const erc20Extensions = await trySignErc20ApprovalExtension(
        this.signer,
        this.options,
        paymentRequirements,
        context,
      );
      if (erc20Extensions) {
        return {
          ...result,
          extensions: erc20Extensions,
        };
      }

      return result;
    }

    return createEIP3009Payload(this.signer, x402Version, paymentRequirements);
  }
}
