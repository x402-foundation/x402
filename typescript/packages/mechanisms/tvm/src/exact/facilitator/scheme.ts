import {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { TvmPaymentPayload } from "../../types";
import {
  ERR_SETTLEMENT_FAILED,
} from "./errors";

/**
 * Configuration for ExactTvmScheme facilitator.
 */
export interface ExactTvmSchemeConfig {
  /** Override facilitator URL (otherwise taken from paymentRequirements.extra) */
  facilitatorUrl?: string;
}

/**
 * TVM facilitator implementation for the Exact payment scheme.
 *
 * Verifies payment signature (Ed25519 over W5R1 body), field checks
 * (recipient, token, amount, expiry, replay), and settles via facilitator /settle.
 */
export class ExactTvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "tvm:*";
  private readonly settledNonces = new Set<string>();
  private readonly facilitatorUrl?: string;

  constructor(config?: ExactTvmSchemeConfig) {
    this.facilitatorUrl = config?.facilitatorUrl;
  }

  getExtra(_network: string): Record<string, unknown> | undefined {
    if (this.facilitatorUrl) {
      return { facilitatorUrl: this.facilitatorUrl };
    }
    return undefined;
  }

  getSigners(_network: string): string[] {
    return [];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    const tvmPayload = payload.payload as unknown as TvmPaymentPayload;
    const payer = tvmPayload.from;

    // Resolve facilitator URL
    const url = this.facilitatorUrl
      ?? (requirements.extra as Record<string, unknown> | undefined)?.facilitatorUrl as string | undefined;
    if (!url) {
      return { isValid: false, invalidReason: "missing_facilitator_url", invalidMessage: "Missing facilitatorUrl", payer };
    }

    // Delegate full verification (signature, BoC parsing, payment intent, replay) to facilitator
    try {
      const resp = await fetch(`${url}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: { payload: tvmPayload },
          paymentRequirements: {
            scheme: requirements.scheme,
            network: requirements.network,
            amount: requirements.amount,
            payTo: requirements.payTo,
            asset: requirements.asset,
          },
        }),
      });

      const data = await resp.json() as { is_valid: boolean; invalid_reason?: string; payer?: string };

      if (!data.is_valid) {
        return {
          isValid: false,
          invalidReason: data.invalid_reason ?? "verification_failed",
          invalidMessage: data.invalid_reason ?? "Facilitator verification failed",
          payer,
        };
      }

      return { isValid: true, payer };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { isValid: false, invalidReason: "verification_error", invalidMessage: `Verification error: ${message}`, payer };
    }
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const verification = await this.verify(payload, requirements, context);
    if (!verification.isValid) {
      return {
        success: false,
        errorReason: verification.invalidReason,
        errorMessage: verification.invalidMessage,
        payer: verification.payer,
        transaction: "",
        network: requirements.network,
      };
    }

    const tvmPayload = payload.payload as unknown as TvmPaymentPayload;

    // Resolve facilitator URL
    const url = this.facilitatorUrl
      ?? (requirements.extra as Record<string, unknown> | undefined)?.facilitatorUrl as string | undefined;
    if (!url) {
      return {
        success: false,
        errorReason: ERR_SETTLEMENT_FAILED,
        errorMessage: "Missing facilitatorUrl for settlement",
        payer: tvmPayload.from,
        transaction: "",
        network: requirements.network,
      };
    }

    try {
      const settleResponse = await fetch(`${url}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: { payload: tvmPayload },
          paymentRequirements: {
            scheme: requirements.scheme,
            network: requirements.network,
            amount: requirements.amount,
            payTo: requirements.payTo,
            asset: requirements.asset,
          },
        }),
      });

      const settleData = await settleResponse.json() as {
        success: boolean; transaction?: string; error_reason?: string; payer?: string; network?: string;
      };

      if (!settleData.success) {
        throw new Error(settleData.error_reason ?? `Facilitator /settle failed: ${settleResponse.status}`);
      }

      this.settledNonces.add(tvmPayload.nonce);

      return {
        success: true,
        payer: tvmPayload.from,
        transaction: settleData.transaction ?? "",
        network: (settleData.network ?? requirements.network) as `${string}:${string}`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errorReason: ERR_SETTLEMENT_FAILED,
        errorMessage: `Settlement failed: ${message}`,
        payer: tvmPayload.from,
        transaction: "",
        network: requirements.network,
      };
    }
  }
}
