/**
 * AuthCapture Scheme - Facilitator
 * Handles verification and settlement of auth-capture payments.
 *
 * Implements x402's SchemeNetworkFacilitator interface so the auth-capture scheme
 * is a drop-in for the x402 facilitator, just like ExactEvmScheme.
 *
 * Dispatches on `payload.type`: collect (authorize/charge) when absent, lifecycle
 * (capture/void/refund) when present. Operator type, not bytecode, selects the
 * settle target.
 */

import type {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { InMemoryPendingSettlementStore, PendingSettlementStore } from "@x402/core/facilitator";
import type { FacilitatorEvmSigner } from "../../signer";
import { resolveDataSuffix } from "../../shared/extensions";
import { AUTH_CAPTURE_SCHEME } from "../constants";
import type { AuthCaptureFacilitatorConfig } from "../types";
import { isAuthCaptureCollectPayload, isLifecyclePayload } from "../types";
import * as Errors from "../errors";
import { facilitatorAddresses } from "./utils";
import { verifyCollect, settleCollect } from "./collect";
import { verifyLifecycle, settleLifecycle } from "./lifecycle";

export type { AuthCaptureFacilitatorConfig } from "../types";

/**
 * AuthCapture Facilitator Scheme - implements x402's SchemeNetworkFacilitator.
 *
 * Settle dispatch:
 *  - no `payload.type` + extra.paymentFlow escrow (default) → escrow.authorize()
 *  - no `payload.type` + extra.paymentFlow authorization → escrow.charge()
 *  - payload.type capture / void / refund → lifecycle
 *
 * Asset-transfer dispatch (extra.assetTransferMethod):
 *  - 'eip3009' (default) → ERC-3009 ReceiveWithAuthorization, EIP3009_TOKEN_COLLECTOR
 *  - 'permit2'           → Permit2 PermitTransferFrom, PERMIT2_TOKEN_COLLECTOR
 */
export class AuthCaptureEvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = AUTH_CAPTURE_SCHEME;
  readonly caipFamily = "eip155:*";
  private readonly signers: readonly FacilitatorEvmSigner[];
  private readonly pendingStore: PendingSettlementStore;

  /**
   * Construct a facilitator-side auth-capture scheme bound to one or more signers.
   * Pass an array of single-address `toFacilitatorEvmSigner` results to rotate
   * submitters — do not register the scheme twice on the same network.
   *
   * @param signer - Facilitator signer, or a set of signers to rotate across.
   * @param config - Optional fee terms, operator allowlist, delegated refund funding.
   */
  constructor(
    signer: FacilitatorEvmSigner | readonly FacilitatorEvmSigner[],
    private config?: AuthCaptureFacilitatorConfig,
  ) {
    this.signers = Array.isArray(signer) ? [...signer] : [signer];
    this.pendingStore = config?.pendingSettlementStore ?? new InMemoryPendingSettlementStore();
  }

  /**
   * Return the flattened, deduped addresses this facilitator submits from.
   *
   * @param _ - Unused network argument (interface compatibility).
   * @returns The facilitator's submitter address(es) on this network.
   */
  getSigners(_: string): string[] {
    return [...facilitatorAddresses(this.signers)];
  }

  /**
   * Facilitator-injected `extra` fields for `/supported`: a randomly selected
   * `captureAuthorizer`, optional receiver authorizer, grouped fee terms, and
   * the custom-operator allowlist.
   *
   * @param _ - Unused network argument (interface compatibility).
   * @returns Extra to merge into payment requirements, or undefined when empty.
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    const extra: Record<string, unknown> = {};
    const addresses = facilitatorAddresses(this.signers);
    if (addresses.length > 0) {
      extra.captureAuthorizer = addresses[Math.floor(Math.random() * addresses.length)];
    }
    if (this.config?.receiverAuthorizer) {
      extra.receiverAuthorizer = this.config.receiverAuthorizer;
    }
    if (this.config?.feeTerms) {
      extra.feeRecipient = this.config.feeTerms.feeRecipient;
      extra.minFeeBps = this.config.feeTerms.minFeeBps;
      extra.maxFeeBps = this.config.feeTerms.maxFeeBps;
    }
    if (
      this.config?.operators &&
      this.config.operators.length > 0 &&
      this.signers.length > 0 &&
      this.signers.every(member => member.simulateCalls)
    ) {
      extra.operators = this.config.operators;
    }
    return Object.keys(extra).length > 0 ? extra : undefined;
  }

  /**
   * Verify a payment payload against the published requirements without
   * touching state.
   *
   * @param payload - The wire payload from the payer or resource server.
   * @param requirements - The server's published payment requirements.
   * @param context - Optional facilitator context for extension hooks.
   * @returns A `VerifyResponse` with `isValid` and, on failure, a stable `invalidReason`.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    const raw = payload.payload;
    if (isLifecyclePayload(raw)) {
      return verifyLifecycle(this.signers, this.config, payload, requirements, raw);
    }
    if (isAuthCaptureCollectPayload(raw)) {
      const dataSuffix = await resolveDataSuffix(context, {
        paymentPayload: payload,
        paymentRequirements: requirements,
      });
      return verifyCollect(this.signers, this.config, payload, requirements, raw, dataSuffix);
    }
    if (typeof raw === "object" && raw !== null && "type" in raw) {
      return { isValid: false, invalidReason: Errors.ErrInvalidPayloadType };
    }
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat };
  }

  /**
   * Verify-then-settle. Re-runs `verify()` against the payload, then submits
   * the collect or lifecycle call.
   *
   * @param payload - The wire payload from the payer or resource server.
   * @param requirements - The server's published payment requirements.
   * @param context - Optional facilitator context for extension hooks (e.g.
   *                  builder-code calldata suffixes).
   * @returns A `SettleResponse` with `success`, the transaction hash (on
   *          success), and a stable `errorReason` (on failure).
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const raw = payload.payload;
    if (isLifecyclePayload(raw)) {
      return settleLifecycle(
        this.signers,
        this.config,
        payload,
        requirements,
        raw,
        this.pendingStore,
        context,
      );
    }
    if (isAuthCaptureCollectPayload(raw)) {
      return settleCollect(
        this.signers,
        this.config,
        payload,
        requirements,
        raw,
        this.pendingStore,
        context,
      );
    }
    return {
      success: false,
      errorReason:
        typeof raw === "object" && raw !== null && "type" in raw
          ? Errors.ErrInvalidPayloadType
          : Errors.ErrInvalidPayloadFormat,
      transaction: "",
      network: requirements.network,
    };
  }
}
