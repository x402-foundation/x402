/** Expiring payer authorization for server-signed batch-settlement channels. */

import {
  createSignableMessage,
  getBase58Decoder,
  getBase58Encoder,
  type MessagePartialSigner,
} from "@solana/kit";

import { verifyEd25519Signature } from "../payment-channels/voucher";
import { AUTHORIZATION_DOMAIN } from "./constants";
import type { BatchAuthorization, BatchAuthorizationFormat } from "./types";

/**
 * Encode the channel-bound proof that lets an operator meter requests.
 *
 * @param args - Authorization identities
 * @param args.channelId - Channel PDA
 * @param args.payer - Channel payer
 * @param args.operator - Delegated voucher signer
 * @param args.requestId - Single-use request identifier
 * @param args.authorizedAmount - Maximum charge in atomic units
 * @param args.expiresAt - Unix timestamp after which the proof is invalid
 * @param args.format - Explicit proof encoding; defaults to binary
 * @returns Bytes the payer signs
 */
export function encodeBatchAuthorizationMessage(args: {
  channelId: string;
  payer: string;
  operator: string;
  requestId: string;
  authorizedAmount: bigint;
  expiresAt: number;
  format?: BatchAuthorizationFormat | undefined;
}): Uint8Array {
  const format = resolveBatchAuthorizationFormat(args.format);
  const base58 = getBase58Encoder();
  const channel = base58.encode(args.channelId);
  const payer = base58.encode(args.payer);
  const operator = base58.encode(args.operator);
  if (channel.byteLength !== 32 || payer.byteLength !== 32 || operator.byteLength !== 32) {
    throw new Error("batch authorization keys must decode to 32 bytes");
  }
  if (!Number.isSafeInteger(args.expiresAt) || args.expiresAt <= 0) {
    throw new Error("batch authorization expiresAt must be a positive safe integer");
  }
  const requestId = new TextEncoder().encode(args.requestId);
  if (requestId.byteLength === 0 || requestId.byteLength > 256) {
    throw new Error("batch authorization requestId must encode to 1 through 256 bytes");
  }
  if (args.authorizedAmount < 0n || args.authorizedAmount > 0xffff_ffff_ffff_ffffn) {
    throw new Error("batch authorization authorizedAmount must fit in a u64");
  }
  if (format === "text-v1") {
    // JSON escaping plus ASCII-only Unicode escapes prevent field injection,
    // hidden control characters, and lossy UTF-8 wallet conversions.
    const escapedRequestId = JSON.stringify(args.requestId).replace(
      /[^\x20-\x7e]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    return new TextEncoder().encode(
      [
        "x402-batch-authorization-text-v1",
        args.authorizedAmount === 0n
          ? "Request refund of unused channel funds."
          : "Authorize a charge up to the amount below.",
        `Payer: ${args.payer}`,
        `Channel: ${args.channelId}`,
        `Operator: ${args.operator}`,
        `Maximum amount (atomic units): ${args.authorizedAmount.toString()}`,
        `Request ID (JSON string): ${escapedRequestId}`,
        `Expires at (Unix seconds): ${args.expiresAt}`,
      ].join("\n"),
    );
  }
  const message = new Uint8Array(AUTHORIZATION_DOMAIN.byteLength + 114 + requestId.byteLength);
  message.set(AUTHORIZATION_DOMAIN, 0);
  message.set(channel, AUTHORIZATION_DOMAIN.byteLength);
  message.set(payer, AUTHORIZATION_DOMAIN.byteLength + 32);
  message.set(operator, AUTHORIZATION_DOMAIN.byteLength + 64);
  const data = new DataView(message.buffer);
  data.setUint16(AUTHORIZATION_DOMAIN.byteLength + 96, requestId.byteLength, true);
  message.set(requestId, AUTHORIZATION_DOMAIN.byteLength + 98);
  data.setBigUint64(
    AUTHORIZATION_DOMAIN.byteLength + 98 + requestId.byteLength,
    args.authorizedAmount,
    true,
  );
  data.setBigInt64(
    AUTHORIZATION_DOMAIN.byteLength + 106 + requestId.byteLength,
    BigInt(args.expiresAt),
    true,
  );
  return message;
}

/**
 * Sign an expiring authorization for one operator-bound channel.
 *
 * @param payer - Channel payer and proof signer
 * @param channelId - Channel PDA
 * @param operator - Delegated voucher signer
 * @param requestId - Single-use request identifier
 * @param authorizedAmount - Maximum charge in atomic units
 * @param expiresAt - Unix timestamp after which the proof is invalid
 * @param format - Explicit proof encoding; defaults to binary
 * @returns Expiring bearer proof
 */
export async function signBatchAuthorization(
  payer: MessagePartialSigner,
  channelId: string,
  operator: string,
  requestId: string,
  authorizedAmount: bigint,
  expiresAt: number,
  format: BatchAuthorizationFormat = "binary",
): Promise<BatchAuthorization> {
  const message = encodeBatchAuthorizationMessage({
    channelId,
    operator,
    payer: payer.address,
    requestId,
    authorizedAmount,
    expiresAt,
    format,
  });
  const [signatures] = await payer.signMessages([createSignableMessage(message)]);
  const signature = signatures[payer.address];
  if (!signature) throw new Error("payer did not return a batch authorization signature");
  return {
    type: "proof",
    ...(format === "text-v1" ? { format } : {}),
    channelId,
    payer: payer.address,
    requestId,
    authorizedAmount: authorizedAmount.toString(),
    expiresAt,
    signature: getBase58Decoder().decode(signature as Uint8Array),
  };
}

/**
 * Verify an unexpired server-mode authorization against the channel payer.
 *
 * @param authorization - Payer's bearer proof
 * @param operator - Operator the proof must bind
 * @param nowSeconds - Current Unix time used for expiry validation
 * @returns Whether the payer signature is valid
 */
export async function verifyBatchAuthorization(
  authorization: BatchAuthorization,
  operator: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  try {
    if (authorization.expiresAt <= nowSeconds) return false;
    if (
      authorization.format === "text-v1" &&
      authorization.authorizedAmount !== BigInt(authorization.authorizedAmount).toString()
    )
      return false;
    const base58 = getBase58Encoder();
    return await verifyEd25519Signature({
      message: encodeBatchAuthorizationMessage({
        channelId: authorization.channelId,
        operator,
        payer: authorization.payer,
        requestId: authorization.requestId,
        authorizedAmount: BigInt(authorization.authorizedAmount),
        expiresAt: authorization.expiresAt,
        format: authorization.format,
      }),
      publicKey: base58.encode(authorization.payer) as Uint8Array,
      signature: base58.encode(authorization.signature) as Uint8Array,
    });
  } catch {
    return false;
  }
}

/**
 * Resolve a wire-format value without silently falling back on unknown versions.
 *
 * @param value - Optional format from the wire or local configuration
 * @returns The selected known format
 */
export function resolveBatchAuthorizationFormat(value: unknown): BatchAuthorizationFormat {
  if (value === undefined) return "binary";
  if (value === "binary" || value === "text-v1") return value;
  throw new Error("unsupported batch authorization format");
}
