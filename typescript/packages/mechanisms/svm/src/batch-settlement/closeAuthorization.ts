/**
 * Server-signed authorization for an immediate cooperative close.
 *
 * The receiver authorizer signs the SHA-256 digest of a domain-separated
 * message binding the network, program, sponsor, channel, final voucher and
 * an expiry, so one signature can authorize exactly one close and nothing
 * else (spec section 4.2, `CloseAuthorization`).
 */

import { sha256 } from "@noble/hashes/sha256";
import {
  createSignableMessage,
  getBase58Decoder,
  getBase58Encoder,
  type MessagePartialSigner,
} from "@solana/kit";

import { PAYMENT_CHANNELS_PROGRAM_ID } from "../payment-channels/onchain";
import { verifyEd25519Signature } from "../payment-channels/voucher";
import { CLOSE_DOMAIN } from "./constants";
import type { CloseAuthorization } from "./types";

/** Fields the close authorization commits to. */
export interface CloseAuthorizationBinding {
  /** CAIP-2 network identifier from `PaymentRequirements`. */
  network: string;
  /** Sponsor recorded as channel `payee` and `rent_payer` (`extra.feePayer`). */
  feePayer: string;
  /** Channel PDA (base58). */
  channelId: string;
  /** Final voucher cumulative amount in atomic units. */
  maxClaimableAmount: bigint;
  /** Final voucher expiry; `0` in this scheme. */
  voucherExpiresAt: bigint;
  /** Unix seconds after which the authorization is void. */
  validBefore: number;
  /** Payment-channels program id; defaults to the canonical deployment. */
  programId?: string | undefined;
}

/**
 * SHA-256 digest the receiver authorizer signs:
 *
 * ```text
 * UTF8("x402:batch-settlement:svm:close:v1") || 0x00 ||
 * u16(len(network)).le || UTF8(network) ||
 * programId[32] || feePayer[32] || channelId[32] ||
 * u64(maxClaimableAmount).le || i64(voucherExpiresAt).le || i64(validBefore).le
 * ```
 *
 * @param binding - Fields to commit to
 * @returns The 32-byte digest
 */
export function encodeCloseAuthorizationDigest(binding: CloseAuthorizationBinding): Uint8Array {
  const base58 = getBase58Encoder();
  const network = new TextEncoder().encode(binding.network);
  if (network.byteLength === 0 || network.byteLength > 0xffff) {
    throw new Error("close authorization network must encode to 1 through 65535 bytes");
  }
  const keys = [
    binding.programId ?? PAYMENT_CHANNELS_PROGRAM_ID,
    binding.feePayer,
    binding.channelId,
  ].map(key => base58.encode(key) as Uint8Array);
  if (keys.some(key => key.byteLength !== 32)) {
    throw new Error("close authorization keys must decode to 32 bytes");
  }
  if (binding.maxClaimableAmount < 0n || binding.maxClaimableAmount > 0xffff_ffff_ffff_ffffn) {
    throw new Error("close authorization maxClaimableAmount must fit in a u64");
  }
  if (!Number.isSafeInteger(binding.validBefore) || binding.validBefore <= 0) {
    throw new Error("close authorization validBefore must be a positive safe integer");
  }
  const message = new Uint8Array(CLOSE_DOMAIN.byteLength + 1 + 2 + network.byteLength + 96 + 24);
  const view = new DataView(message.buffer);
  let offset = 0;
  message.set(CLOSE_DOMAIN, offset);
  offset += CLOSE_DOMAIN.byteLength;
  message[offset] = 0x00;
  offset += 1;
  view.setUint16(offset, network.byteLength, true);
  offset += 2;
  message.set(network, offset);
  offset += network.byteLength;
  for (const key of keys) {
    message.set(key, offset);
    offset += 32;
  }
  view.setBigUint64(offset, binding.maxClaimableAmount, true);
  offset += 8;
  view.setBigInt64(offset, binding.voucherExpiresAt, true);
  offset += 8;
  view.setBigInt64(offset, BigInt(binding.validBefore), true);
  return sha256(message);
}

/**
 * Sign a close authorization with the server's receiver authorizer.
 *
 * @param authorizer - Receiver-authorizer key advertised as `extra.receiverAuthorizer`
 * @param binding - Fields to commit to
 * @returns The wire `CloseAuthorization`
 */
export async function signCloseAuthorization(
  authorizer: MessagePartialSigner,
  binding: CloseAuthorizationBinding,
): Promise<CloseAuthorization> {
  const digest = encodeCloseAuthorizationDigest(binding);
  const [signatures] = await authorizer.signMessages([createSignableMessage(digest)]);
  const signature = signatures[authorizer.address];
  if (!signature) throw new Error("receiver authorizer did not return a close signature");
  return {
    validBefore: binding.validBefore,
    signature: getBase58Decoder().decode(signature as Uint8Array),
  };
}

/**
 * Verify a close authorization against the receiver authorizer bound to the
 * channel, requiring `now < validBefore <= now + maxTimeoutSeconds`.
 *
 * @param authorization - The wire `CloseAuthorization`
 * @param binding - Fields the signature must commit to; `validBefore` is taken from the authorization
 * @param receiverAuthorizer - Trusted receiver-authorizer key (base58)
 * @param maxTimeoutSeconds - Longest validity window the facilitator accepts
 * @param nowSeconds - Current Unix time
 * @returns Whether the authorization is valid and unexpired
 */
export async function verifyCloseAuthorization(
  authorization: CloseAuthorization,
  binding: Omit<CloseAuthorizationBinding, "validBefore">,
  receiverAuthorizer: string,
  maxTimeoutSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  try {
    if (
      !Number.isSafeInteger(authorization.validBefore) ||
      authorization.validBefore <= nowSeconds ||
      authorization.validBefore > nowSeconds + maxTimeoutSeconds
    ) {
      return false;
    }
    const base58 = getBase58Encoder();
    return await verifyEd25519Signature({
      message: encodeCloseAuthorizationDigest({
        ...binding,
        validBefore: authorization.validBefore,
      }),
      publicKey: base58.encode(receiverAuthorizer) as Uint8Array,
      signature: base58.encode(authorization.signature) as Uint8Array,
    });
  } catch {
    return false;
  }
}
