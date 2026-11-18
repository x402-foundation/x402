import {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { InMemoryPendingSettlementStore, PendingSettlementStore } from "@x402/core/facilitator";
import { FacilitatorEvmSigner } from "../../signer";
import {
  ExactEIP3009Payload,
  ExactPermit2Payload,
  getExactEvmPayloadPayer,
  isPermit2Payload,
  validateExactEvmPayload,
} from "../../types";
import { verifyEIP3009, settleEIP3009 } from "./eip3009";
import * as Errors from "./errors";
import { verifyPermit2, settlePermit2 } from "./permit2";

export interface ExactEvmSchemeConfig {
  /**
   * Allowlist of factory contract addresses (hex strings, case-insensitive) that the facilitator
   * will call when deploying an undeployed smart wallet via ERC-6492.
   *
   * A non-empty list enables ERC-4337 smart wallet deployment via EIP-6492. An empty or omitted
   * list denies all factory deployment calls (feature disabled by default).
   *
   * @default []
   */
  eip6492AllowedFactories?: string[];
  /**
   * If enabled, run on-chain simulation during settle's re-verify.
   *
   * @default false
   */
  simulateInSettle?: boolean;
  /**
   * Lets a retried settle for the same payload reconcile against an
   * already-broadcast transaction instead of re-verifying and
   * re-broadcasting (see {@link PendingSettlementStore}). Defaults to a
   * fresh in-memory store shared across all settle calls on this scheme
   * instance. Inject a shared, network-backed implementation (e.g. Redis)
   * for a multi-instance facilitator so a settle retry landing on a
   * different replica still reconciles correctly.
   */
  pendingSettlementStore?: PendingSettlementStore;
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
  private readonly config: Required<Omit<ExactEvmSchemeConfig, "pendingSettlementStore">>;
  private readonly pendingStore: PendingSettlementStore;

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
      eip6492AllowedFactories: config?.eip6492AllowedFactories ?? [],
      simulateInSettle: config?.simulateInSettle ?? false,
    };
    this.pendingStore = config?.pendingSettlementStore ?? new InMemoryPendingSettlementStore();
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
   * @param _ - Payment required extensions (unused; reserved for interface parity)
   * @returns Promise resolving to verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
    _?: Record<string, unknown>,
  ): Promise<VerifyResponse> {
    const payloadError = validateExactEvmPayload(payload.payload);
    if (payloadError) {
      return {
        isValid: false,
        invalidReason: Errors.ErrInvalidPayload,
        invalidMessage: payloadError,
        payer: getExactEvmPayloadPayer(payload.payload),
      };
    }

    const body = payload.payload as ExactEIP3009Payload | ExactPermit2Payload;
    if (isPermit2Payload(body)) {
      return verifyPermit2(this.signer, payload, requirements, body, context);
    }

    const { response } = await verifyEIP3009(
      this.signer,
      payload,
      requirements,
      body,
      undefined,
      this.config.eip6492AllowedFactories,
    );
    return response;
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
    const payloadError = validateExactEvmPayload(payload.payload);
    if (payloadError) {
      return {
        success: false,
        errorReason: Errors.ErrInvalidPayload,
        errorMessage: payloadError,
        payer: getExactEvmPayloadPayer(payload.payload),
        transaction: "",
        network: requirements.network,
      };
    }

    const body = payload.payload as ExactEIP3009Payload | ExactPermit2Payload;
    if (isPermit2Payload(body)) {
      return settlePermit2(
        this.signer,
        payload,
        requirements,
        body,
        context,
        { simulateInSettle: this.config.simulateInSettle },
        this.pendingStore,
      );
    }

    return settleEIP3009(
      this.signer,
      payload,
      requirements,
      body,
      this.config,
      context,
      this.pendingStore,
    );
  }
}
