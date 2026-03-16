import {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
  Network,
} from "@x402/core/types";
import { Cell } from "@ton/core";
import { TvmPaymentPayload } from "../../types";
import {
  ERR_INVALID_SIGNATURE,
  ERR_PAYMENT_EXPIRED,
  ERR_WRONG_RECIPIENT,
  ERR_WRONG_TOKEN,
  ERR_AMOUNT_MISMATCH,
  ERR_REPLAY,
  ERR_MISSING_SETTLEMENT_DATA,
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

    // Check settlement data
    if (!tvmPayload.settlementBoc || !tvmPayload.walletPublicKey) {
      return {
        isValid: false,
        invalidReason: ERR_MISSING_SETTLEMENT_DATA,
        invalidMessage: "Missing settlementBoc or walletPublicKey",
        payer: tvmPayload.from,
      };
    }

    // Verify Ed25519 signature on the settlement BoC
    try {
      const bocBuffer = Buffer.from(tvmPayload.settlementBoc, "base64");
      const cell = Cell.fromBoc(bocBuffer)[0];
      // External message body is in a ref (standard serialization)
      const bodyCell = cell.refs[0] ?? cell;
      const bodySlice = bodyCell.beginParse();

      if (bodySlice.remainingBits < 512) {
        return {
          isValid: false,
          invalidReason: ERR_INVALID_SIGNATURE,
          invalidMessage: "BoC body too short for Ed25519 signature",
          payer: tvmPayload.from,
        };
      }

      const signature = bodySlice.loadBuffer(64);

      // Reconstruct the signed payload cell from remaining bits/refs
      const remainingCell = bodySlice.asCell();

      // Verify signature: Ed25519(payload_cell_hash, pubkey)
      const pubkeyBuffer = Buffer.from(tvmPayload.walletPublicKey, "hex");
      if (pubkeyBuffer.length !== 32) {
        return {
          isValid: false,
          invalidReason: ERR_INVALID_SIGNATURE,
          invalidMessage: "Invalid public key length",
          payer: tvmPayload.from,
        };
      }

      // The signed data is the hash of the payload cell (everything after the signature)
      const payloadHash = remainingCell.hash();
      const nacl = await import("tweetnacl");
      const isValidSig = nacl.sign.detached.verify(
        payloadHash,
        signature,
        pubkeyBuffer,
      );

      if (!isValidSig) {
        return {
          isValid: false,
          invalidReason: ERR_INVALID_SIGNATURE,
          invalidMessage: "Ed25519 signature verification failed",
          payer: tvmPayload.from,
        };
      }
    } catch (err: unknown) {
      // If BoC parsing fails, signature is invalid
      const message = err instanceof Error ? err.message : String(err);
      return {
        isValid: false,
        invalidReason: ERR_INVALID_SIGNATURE,
        invalidMessage: `Signature verification error: ${message}`,
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
          settlementBoc: tvmPayload.settlementBoc,
          walletPublicKey: tvmPayload.walletPublicKey,
          from: tvmPayload.from,
          to: tvmPayload.to,
          tokenMaster: tvmPayload.tokenMaster,
          amount: tvmPayload.amount,
          nonce: tvmPayload.nonce,
        }),
      });

      if (!settleResponse.ok) {
        const error = await settleResponse.text();
        throw new Error(`Facilitator /settle failed: ${settleResponse.status} ${error}`);
      }

      this.settledNonces.add(tvmPayload.nonce);

      return {
        success: true,
        payer: tvmPayload.from,
        transaction: `settle-${tvmPayload.nonce.slice(0, 8)}`,
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
