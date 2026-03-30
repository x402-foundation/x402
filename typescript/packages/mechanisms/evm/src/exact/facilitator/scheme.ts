import {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { FacilitatorEvmSigner } from "../../signer";
import { ExactEvmPayloadV2, ExactEIP3009Payload, isPermit2Payload } from "../../types";
import { verifyEIP3009, settleEIP3009 } from "./eip3009";
import { verifyPermit2, settlePermit2 } from "./permit2";

export interface ExactEvmSchemeConfig {
  /**
   * If enabled, the facilitator will deploy ERC-4337 smart wallets
   * via EIP-6492 when encountering undeployed contract signatures.
   *
   * @default false
   */
  deployERC4337WithEIP6492?: boolean;
  /**
   * If enabled, run on-chain simulation during settle's re-verify.
   *
   * @default false
   */
  simulateInSettle?: boolean;
}

/**
 * EVM facilitator implementation for the Exact payment scheme.
 * Thin router that delegates to EIP-3009 or Permit2 based on payload type.
 * All extension handling (EIP-2612, ERC-20 approval gas sponsoring) is owned
 * by the Permit2 functions via FacilitatorContext.
 */
export class ExactEvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "eip155:*";
  private readonly config: Required<ExactEvmSchemeConfig>;

  /**
   * Creates a new ExactEvmScheme facilitator instance.
   *
   * @param signer - The EVM signer for facilitator operations
   * @param config - Optional configuration
   */
  constructor(
    private readonly signer: FacilitatorEvmSigner,
    config?: ExactEvmSchemeConfig,
  ) {
    this.config = {
      deployERC4337WithEIP6492: config?.deployERC4337WithEIP6492 ?? false,
      simulateInSettle: config?.simulateInSettle ?? false,
    };
  }

  /**
   * Returns undefined — EVM has no mechanism-specific extra data.
   *
   * @param _ - The network identifier (unused)
   * @returns undefined
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   * Returns facilitator wallet addresses for the supported response.
   *
   * @param _ - The network identifier (unused, addresses are network-agnostic)
   * @returns Array of facilitator wallet addresses
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verifies a payment payload. Routes to Permit2 or EIP-3009 based on payload type.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements
   * @param context - Optional facilitator context for extension capabilities
   * @returns Promise resolving to verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    const rawPayload = payload.payload as ExactEvmPayloadV2;
    const isPermit2 = isPermit2Payload(rawPayload);

    if (isPermit2) {
      return verifyPermit2(this.signer, payload, requirements, rawPayload, context);
    }

    const eip3009Payload: ExactEIP3009Payload = rawPayload;
    return verifyEIP3009(this.signer, payload, requirements, eip3009Payload);
  }

  /**
   * Settles a payment. Routes to Permit2 or EIP-3009 based on payload type.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements
   * @param context - Optional facilitator context for extension capabilities
   * @returns Promise resolving to settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const rawPayload = payload.payload as ExactEvmPayloadV2;
    const isPermit2 = isPermit2Payload(rawPayload);

    if (isPermit2) {
      return settlePermit2(this.signer, payload, requirements, rawPayload, context, {
        simulateInSettle: this.config.simulateInSettle,
      });
    }

    const eip3009Payload: ExactEIP3009Payload = rawPayload;
    return settleEIP3009(this.signer, payload, requirements, eip3009Payload, this.config);
  }
}
