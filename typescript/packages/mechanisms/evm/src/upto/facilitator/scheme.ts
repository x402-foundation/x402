import {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { FacilitatorEvmSigner } from "../../signer";
import { UptoPermit2Payload, isUptoPermit2Payload } from "../../types";
import { verifyUptoPermit2, settleUptoPermit2 } from "./permit2";

/**
 * EVM facilitator implementation for the Upto payment scheme.
 * Handles verification and settlement of Permit2-based payments.
 */
export class UptoEvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "upto";
  readonly caipFamily = "eip155:*";

  /**
   * Creates a new UptoEvmScheme facilitator instance.
   *
   * @param signer - The EVM signer for facilitator operations
   */
  constructor(private readonly signer: FacilitatorEvmSigner) {}

  /**
   * Returns extra metadata required by the upto scheme, including the facilitator address.
   *
   * @param _ - The network identifier (unused)
   * @returns Object with facilitatorAddress, or undefined if no signer addresses are available
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    const addresses = this.signer.getAddresses();
    if (addresses.length === 0) {
      return undefined;
    }
    return { facilitatorAddress: addresses[Math.floor(Math.random() * addresses.length)] };
  }

  /**
   * Returns the list of facilitator signer addresses for the upto scheme.
   *
   * @param _ - The network identifier (unused)
   * @returns Array of facilitator signer addresses
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verifies an upto Permit2 payment payload against the given requirements.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements to verify against
   * @param context - Optional facilitator context
   * @returns Promise resolving to a verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    const rawPayload = payload.payload as Record<string, unknown>;
    if (!isUptoPermit2Payload(rawPayload)) {
      return { isValid: false, invalidReason: "unsupported_payload_type", payer: "" };
    }
    return verifyUptoPermit2(
      this.signer,
      payload,
      requirements,
      rawPayload as UptoPermit2Payload,
      context,
    );
  }

  /**
   * Settles an upto Permit2 payment on-chain.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements
   * @param context - Optional facilitator context
   * @returns Promise resolving to a settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const rawPayload = payload.payload as Record<string, unknown>;
    if (!isUptoPermit2Payload(rawPayload)) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "unsupported_payload_type",
        payer: "",
      };
    }
    return settleUptoPermit2(
      this.signer,
      payload,
      requirements,
      rawPayload as UptoPermit2Payload,
      context,
    );
  }
}
