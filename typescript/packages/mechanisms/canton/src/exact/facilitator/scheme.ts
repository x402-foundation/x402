/**
 * Canton facilitator implementation of the `exact` scheme.
 *
 * `verify` proves the payer-signed inline transfer against the merchant's
 * requirements (see verify-inline.ts). `settle` re-verifies, then relays the
 * signed transaction through the injected `FacilitatorCantonSigner`
 * (ExecuteSubmission) and confirms funds actually moved before reporting success.
 */
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  VerifyResponse,
  SettleResponse,
} from "@x402/core/types";
import { CANTON_CAIP_FAMILY } from "../../constants.js";
import type { CantonErrorCode } from "../../types.js";
import type { FacilitatorCantonSigner, CantonSchemeConfig } from "../../signer.js";
import { verifyInlineTransfer } from "./verify-inline.js";
import { SubmissionOutcomeUnknownError } from "../../ledger/transfer-factory.js";

/** Options for the Canton facilitator scheme. */
export interface CantonFacilitatorOptions extends CantonSchemeConfig {
  /** The Global Synchronizer id this facilitator settles on, advertised in the
   *  402 `extra.synchronizerId` via {@link ExactCantonScheme.getExtra}. */
  synchronizerId?: string;
}

/** Facilitator-side `exact` scheme for Canton networks. */
export class ExactCantonScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = CANTON_CAIP_FAMILY;

  /**
   * Construct the facilitator-side Canton exact scheme.
   *
   * @param signer - Ledger access + facilitator relaying key(s).
   * @param options - Trust anchors, registry config, and the synchronizer id.
   */
  constructor(
    private readonly signer: FacilitatorCantonSigner,
    private readonly options: CantonFacilitatorOptions = {},
  ) {}

  /**
   * Mechanism `extra` for the /supported response: this facilitator's feePayer
   * and the synchronizer it settles on.
   *
   * @param _ - The network identifier (unused; one facilitator identity here).
   * @returns The `{ feePayer, synchronizerId }` extra, or undefined when neither is set.
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    const feePayer = this.signer.getAddresses()[0];
    const extra: Record<string, unknown> = {};
    if (feePayer) extra.feePayer = feePayer;
    if (this.options.synchronizerId) extra.synchronizerId = this.options.synchronizerId;
    return Object.keys(extra).length > 0 ? extra : undefined;
  }

  /**
   * Facilitator parties that relay (and pay the Global Synchronizer traffic).
   *
   * @param _ - The network identifier (unused).
   * @returns The facilitator relaying parties.
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Validate a payer-signed inline transfer against the merchant's requirements.
   *
   * @param payload - The x402 payment payload (inline carriage).
   * @param requirements - The merchant's payment requirements.
   * @returns Whether the payment is valid, with the proven payer or a reason.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const r = await verifyInlineTransfer(payload, requirements, this.signer, this.options);
    if (r.ok) {
      return { isValid: true, payer: r.payer };
    }
    return {
      isValid: false,
      invalidReason: r.reason ?? "invalid_exact_canton_malformed_payload",
      ...(r.payer ? { payer: r.payer } : {}),
    };
  }

  /**
   * Verify, then relay the signed transaction and confirm funds moved.
   *
   * @param payload - The x402 payment payload (inline carriage).
   * @param requirements - The merchant's payment requirements.
   * @returns The settlement result: on success the on-ledger updateId.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network;
    const v = await verifyInlineTransfer(payload, requirements, this.signer, this.options);
    if (!v.ok || !v.preparedTransactionBytes) {
      return this.settleFailure(
        v.reason ?? "invalid_exact_canton_malformed_payload",
        network,
        v.payer,
      );
    }

    // The instrument admin — validated against the prepared tx in verify — selects
    // the registry vs Amulet funds-moved signal in the signer's execute.
    const instrumentAdmin = (
      requirements.extra as { instrumentId?: { admin?: string } } | undefined
    )?.instrumentId?.admin;

    let exec;
    try {
      exec = await this.signer.executeSubmission({
        preparedTransactionBytes: v.preparedTransactionBytes,
        signatureB64: v.signatureB64 ?? "",
        payer: v.payer,
        hashingSchemeVersion: v.hashingSchemeVersion ?? "HASHING_SCHEME_VERSION_V2",
        ...(typeof instrumentAdmin === "string" && instrumentAdmin.length > 0
          ? { instrumentAdmin }
          : {}),
      });
    } catch (err) {
      // An unknown outcome (execute committed but the result was unreadable) is
      // NOT a definite rejection: reporting it as the retryable execute failure
      // would invite the payer to re-pay. Surface it as the non-retryable
      // ledger-read error instead.
      if (err instanceof SubmissionOutcomeUnknownError) {
        return this.settleFailure("unexpected_canton_ledger_error", network, v.payer);
      }
      return this.settleFailure("invalid_exact_canton_execute_failed", network, v.payer);
    }

    // Funds-moved gate. A DEFINITE committed-zero-funds execute is not a
    // settlement. But an INCONCLUSIVE funds-moved read (the execute committed and
    // an updateId exists, yet movement could not be confirmed either way) is
    // trusted as settled: the preapproval gate already excluded the pending case,
    // so a committed transfer moved funds — reporting failure here would withhold
    // the resource for a payment that most likely succeeded.
    if (!exec.transferred && !exec.confirmInconclusive) {
      return this.settleFailure("invalid_exact_canton_execute_failed", network, v.payer);
    }

    return {
      success: true,
      payer: v.payer,
      transaction: exec.updateId,
      network,
    };
  }

  /**
   * Build a failed SettleResponse.
   *
   * @param reason - The Canton error code.
   * @param network - The requirements' network.
   * @param payer - The proven payer, when known.
   * @returns The failure response.
   */
  private settleFailure(reason: CantonErrorCode, network: Network, payer: string): SettleResponse {
    return {
      success: false,
      errorReason: reason,
      transaction: "",
      network,
      ...(payer ? { payer } : {}),
    };
  }
}
