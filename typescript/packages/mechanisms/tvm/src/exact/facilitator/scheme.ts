import {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
  Network,
} from "@x402/core/types";
import { FacilitatorTvmSigner } from "../../signer";
import { TvmPaymentPayload } from "../../types";
import {
  ERR_PAYMENT_EXPIRED,
  ERR_WRONG_RECIPIENT,
  ERR_WRONG_TOKEN,
  ERR_AMOUNT_MISMATCH,
  ERR_NO_SIGNED_MESSAGES,
  ERR_REPLAY,
  ERR_MISSING_SETTLEMENT_DATA,
  ERR_SETTLEMENT_FAILED,
} from "./errors";

export interface ExactTvmSchemeConfig {
  /**
   * Maximum allowed age difference (in seconds) between now and validUntil.
   * Payments with validUntil too far in the past are rejected.
   * @default 0 (any non-expired payment is accepted)
   */
  maxAgeSeconds?: number;
}

/**
 * TVM facilitator implementation for the Exact payment scheme.
 *
 * Verifies payment fields (recipient, token, amount, expiry, replay)
 * and settles via TONAPI gasless/send.
 */
export class ExactTvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "tvm:*";
  private readonly settledNonces = new Set<string>();

  constructor(
    private readonly signer: FacilitatorTvmSigner,
    private readonly config?: ExactTvmSchemeConfig,
  ) {}

  /**
   * Returns undefined — TVM has no mechanism-specific extra data.
   */
  getExtra(_network: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   * TVM facilitator doesn't hold signer addresses (gasless relay model).
   * Returns empty array since the relay is the signer.
   */
  getSigners(_network: string): string[] {
    return [];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    const tvmPayload = payload.payload as unknown as TvmPaymentPayload;

    // Check replay
    if (this.settledNonces.has(tvmPayload.nonce)) {
      return {
        isValid: false,
        invalidReason: ERR_REPLAY,
        invalidMessage: "Nonce already used (replay)",
        payer: tvmPayload.from,
      };
    }

    // Check expiry
    if (tvmPayload.validUntil < Math.floor(Date.now() / 1000)) {
      return {
        isValid: false,
        invalidReason: ERR_PAYMENT_EXPIRED,
        invalidMessage: "Payment expired",
        payer: tvmPayload.from,
      };
    }

    // Check recipient
    if (tvmPayload.to !== requirements.payTo) {
      return {
        isValid: false,
        invalidReason: ERR_WRONG_RECIPIENT,
        invalidMessage: `Wrong recipient: expected ${requirements.payTo}, got ${tvmPayload.to}`,
        payer: tvmPayload.from,
      };
    }

    // Check token
    if (tvmPayload.tokenMaster !== requirements.asset) {
      return {
        isValid: false,
        invalidReason: ERR_WRONG_TOKEN,
        invalidMessage: `Wrong token: expected ${requirements.asset}, got ${tvmPayload.tokenMaster}`,
        payer: tvmPayload.from,
      };
    }

    // Check amount (exact match for exact scheme)
    if (BigInt(tvmPayload.amount) < BigInt(requirements.amount)) {
      return {
        isValid: false,
        invalidReason: ERR_AMOUNT_MISMATCH,
        invalidMessage: `Amount insufficient: expected >= ${requirements.amount}, got ${tvmPayload.amount}`,
        payer: tvmPayload.from,
      };
    }

    // Check signed messages exist
    if (!tvmPayload.signedMessages || tvmPayload.signedMessages.length === 0) {
      return {
        isValid: false,
        invalidReason: ERR_NO_SIGNED_MESSAGES,
        invalidMessage: "No signed messages in payload",
        payer: tvmPayload.from,
      };
    }

    // Check settlement data
    if (!tvmPayload.settlementBoc || !tvmPayload.walletPublicKey) {
      return {
        isValid: false,
        invalidReason: ERR_MISSING_SETTLEMENT_DATA,
        invalidMessage: "Missing settlementBoc or walletPublicKey",
        payer: tvmPayload.from,
      };
    }

    return {
      isValid: true,
      payer: tvmPayload.from,
    };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    // Re-verify before settling
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

    try {
      await this.signer.gaslessSend(
        tvmPayload.settlementBoc,
        tvmPayload.walletPublicKey,
      );

      // Mark nonce as used
      this.settledNonces.add(tvmPayload.nonce);

      return {
        success: true,
        payer: tvmPayload.from,
        transaction: `gasless-${tvmPayload.nonce.slice(0, 8)}`,
        network: requirements.network,
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
