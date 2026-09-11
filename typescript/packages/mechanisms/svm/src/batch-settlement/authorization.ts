/** Reusable payer authorization for server-signed batch-settlement channels. */

import {
  createSignableMessage,
  getBase58Decoder,
  getBase58Encoder,
  type MessagePartialSigner,
} from "@solana/kit";

import { verifyEd25519Signature } from "../payment-channels/voucher";
import type { BatchAuthorization } from "./types";

const AUTHORIZATION_DOMAIN = new TextEncoder().encode("x402-batch-authorization-v1");

/**
 * Encode the channel-bound proof that lets an operator meter requests.
 *
 * @param args - Authorization identities
 * @param args.channelId - Channel PDA
 * @param args.payer - Channel payer
 * @param args.operator - Delegated voucher signer
 * @returns Bytes the payer signs
 */
export function encodeBatchAuthorizationMessage(args: {
  channelId: string;
  payer: string;
  operator: string;
}): Uint8Array {
  const base58 = getBase58Encoder();
  const channel = base58.encode(args.channelId);
  const payer = base58.encode(args.payer);
  const operator = base58.encode(args.operator);
  if (channel.byteLength !== 32 || payer.byteLength !== 32 || operator.byteLength !== 32) {
    throw new Error("batch authorization keys must decode to 32 bytes");
  }
  const message = new Uint8Array(AUTHORIZATION_DOMAIN.byteLength + 96);
  message.set(AUTHORIZATION_DOMAIN, 0);
  message.set(channel, AUTHORIZATION_DOMAIN.byteLength);
  message.set(payer, AUTHORIZATION_DOMAIN.byteLength + 32);
  message.set(operator, AUTHORIZATION_DOMAIN.byteLength + 64);
  return message;
}

/**
 * Sign a reusable authorization for one operator-bound channel.
 *
 * @param payer - Channel payer and proof signer
 * @param channelId - Channel PDA
 * @param operator - Delegated voucher signer
 * @returns Reusable bearer proof
 */
export async function signBatchAuthorization(
  payer: MessagePartialSigner,
  channelId: string,
  operator: string,
): Promise<BatchAuthorization> {
  const message = encodeBatchAuthorizationMessage({ channelId, operator, payer: payer.address });
  const [signatures] = await payer.signMessages([createSignableMessage(message)]);
  const signature = signatures[payer.address];
  if (!signature) throw new Error("payer did not return a batch authorization signature");
  return {
    type: "proof",
    channelId,
    payer: payer.address,
    signature: getBase58Decoder().decode(signature as Uint8Array),
  };
}

/**
 * Verify a reusable server-mode authorization against the channel payer.
 *
 * @param authorization - Payer's bearer proof
 * @param operator - Operator the proof must bind
 * @returns Whether the payer signature is valid
 */
export async function verifyBatchAuthorization(
  authorization: BatchAuthorization,
  operator: string,
): Promise<boolean> {
  try {
    const base58 = getBase58Encoder();
    return await verifyEd25519Signature({
      message: encodeBatchAuthorizationMessage({
        channelId: authorization.channelId,
        operator,
        payer: authorization.payer,
      }),
      publicKey: base58.encode(authorization.payer) as Uint8Array,
      signature: base58.encode(authorization.signature) as Uint8Array,
    });
  } catch {
    return false;
  }
}
