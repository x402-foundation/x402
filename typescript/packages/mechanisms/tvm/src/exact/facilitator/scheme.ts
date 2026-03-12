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
import { sign, keyPairFromSeed } from "@ton/crypto";
import { FacilitatorTvmSigner } from "../../signer";
import { TvmPaymentPayload } from "../../types";
import {
  ERR_INVALID_SIGNATURE,
  ERR_PAYMENT_EXPIRED,
  ERR_WRONG_RECIPIENT,
  ERR_WRONG_TOKEN,
  ERR_AMOUNT_MISMATCH,
  ERR_NO_SIGNED_MESSAGES,
  ERR_REPLAY,
  ERR_MISSING_SETTLEMENT_DATA,
  ERR_SETTLEMENT_FAILED,
} from "./errors";

/**
 * TVM facilitator implementation for the Exact payment scheme.
 *
 * Verifies payment signature (Ed25519 over W5R1 body), field checks
 * (recipient, token, amount, expiry, replay), and settles via TONAPI gasless/send.
 */
export class ExactTvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "tvm:*";
  private readonly settledNonces = new Set<string>();

  constructor(
    private readonly signer: FacilitatorTvmSigner,
  ) {}

  getExtra(_network: string): Record<string, unknown> | undefined {
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
      const signedPayloadBuilder = bodySlice.asCell().beginParse();
      // Skip the 512 bits we already consumed — loadBuffer advanced the slice
      // bodySlice is now positioned after the signature
      // Build a cell from remaining data
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
      // Use @ton/crypto verify: reconstruct and check
      // Ed25519 verify: sign(hash, secretKey) === signature
      // We don't have the secret key, but we can verify using nacl-style check
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

    try {
      await this.signer.gaslessSend(
        tvmPayload.settlementBoc,
        tvmPayload.walletPublicKey,
      );

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
