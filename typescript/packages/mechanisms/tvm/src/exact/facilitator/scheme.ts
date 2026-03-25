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
  /** Facilitator URL for delegating verify/settle */
  facilitatorUrl?: string;
}

/**
 * TVM facilitator implementation for the Exact payment scheme.
 *
 * Delegates verification and settlement to a remote facilitator service.
 * The facilitator derives all payment details (sender, amount, destination)
 * from the settlementBoc itself.
 */
export class ExactTvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "tvm:*";
  private readonly facilitatorUrl?: string;

  constructor(config?: ExactTvmSchemeConfig) {
    this.facilitatorUrl = config?.facilitatorUrl;
  }

  getExtra(_network: string): Record<string, unknown> | undefined {
    return undefined;
  }

  getSigners(_network: string): string[] {
    return [];
  }

  private resolveFacilitatorUrl(requirements: PaymentRequirements): string | undefined {
    return this.facilitatorUrl
      ?? (requirements.extra as Record<string, unknown> | undefined)?.facilitatorUrl as string | undefined;
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    const tvmPayload = payload.payload as unknown as TvmPaymentPayload;

    const url = this.resolveFacilitatorUrl(requirements);
    if (!url) {
      return { isValid: false, invalidReason: "missing_facilitator_url", invalidMessage: "Missing facilitatorUrl", payer: "" };
    }

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
            maxTimeoutSeconds: requirements.maxTimeoutSeconds,
          },
        }),
      });

      const data = await resp.json() as Record<string, unknown>;

      const isValid = (data.isValid ?? data.is_valid) as boolean;
      const invalidReason = (data.invalidReason ?? data.invalid_reason) as string | undefined;
      const payer = (data.payer as string) ?? "";

      if (!isValid) {
        return {
          isValid: false,
          invalidReason: invalidReason ?? "verification_failed",
          invalidMessage: invalidReason ?? "Facilitator verification failed",
          payer,
        };
      }

      return { isValid: true, payer };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { isValid: false, invalidReason: "verification_error", invalidMessage: `Verification error: ${message}`, payer: "" };
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

    const url = this.resolveFacilitatorUrl(requirements);
    if (!url) {
      return {
        success: false,
        errorReason: ERR_SETTLEMENT_FAILED,
        errorMessage: "Missing facilitatorUrl for settlement",
        payer: verification.payer,
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
            maxTimeoutSeconds: requirements.maxTimeoutSeconds,
          },
        }),
      });

      const settleData = await settleResponse.json() as Record<string, unknown>;

      if (!settleData.success) {
        const errorReason = (settleData.errorReason ?? settleData.error_reason) as string | undefined;
        throw new Error(errorReason ?? `Facilitator /settle failed: ${settleResponse.status}`);
      }

      return {
        success: true,
        payer: (settleData.payer as string) ?? verification.payer,
        transaction: (settleData.transaction as string) ?? "",
        network: ((settleData.network as string) ?? requirements.network) as `${string}:${string}`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errorReason: ERR_SETTLEMENT_FAILED,
        errorMessage: `Settlement failed: ${message}`,
        payer: verification.payer,
        transaction: "",
        network: requirements.network,
      };
    }
  }
}
