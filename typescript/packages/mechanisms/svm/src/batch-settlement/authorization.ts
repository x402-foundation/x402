/** Expiring payer authorization for server-signed batch-settlement channels. */

import {
  createSignableMessage,
  getBase58Decoder,
  getBase58Encoder,
  type MessagePartialSigner,
} from "@solana/kit";

import { verifyEd25519Signature } from "../payment-channels/voucher";
import type { BatchAuthorization } from "./types";

const AUTHORIZATION_DOMAIN = new TextEncoder().encode("x402-batch-authorization-v2");

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
 * @returns Bytes the payer signs
 */
export function encodeBatchAuthorizationMessage(args: {
  channelId: string;
  payer: string;
  operator: string;
  requestId: string;
  authorizedAmount: bigint;
  expiresAt: number;
}): Uint8Array {
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
 * @returns Expiring bearer proof
 */
export async function signBatchAuthorization(
  payer: MessagePartialSigner,
  channelId: string,
  operator: string,
  requestId: string,
  authorizedAmount: bigint,
  expiresAt: number,
): Promise<BatchAuthorization> {
  const message = encodeBatchAuthorizationMessage({
    channelId,
    operator,
    payer: payer.address,
    requestId,
    authorizedAmount,
    expiresAt,
  });
  const [signatures] = await payer.signMessages([createSignableMessage(message)]);
  const signature = signatures[payer.address];
  if (!signature) throw new Error("payer did not return a batch authorization signature");
  return {
    type: "proof",
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
    const base58 = getBase58Encoder();
    return await verifyEd25519Signature({
      message: encodeBatchAuthorizationMessage({
        channelId: authorization.channelId,
        operator,
        payer: authorization.payer,
        requestId: authorization.requestId,
        authorizedAmount: BigInt(authorization.authorizedAmount),
        expiresAt: authorization.expiresAt,
      }),
      publicKey: base58.encode(authorization.payer) as Uint8Array,
      signature: base58.encode(authorization.signature) as Uint8Array,
    });
  } catch {
    return false;
  }
}
