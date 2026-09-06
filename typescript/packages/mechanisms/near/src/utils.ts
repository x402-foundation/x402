import { PublicKey } from "@near-js/crypto";
import { type DelegateAction, SCHEMA, encodeDelegateAction } from "@near-js/transactions";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { deserialize } from "borsh";
import { ESTIMATED_BLOCK_SECONDS } from "./constants";
import type { NearFtTransferArgs } from "./types";

/**
 * Curve names this scheme recognizes (spec §4: `ed25519` or `secp256k1`).
 */
export type NearCurve = "ed25519" | "secp256k1";

/**
 * A single decoded NEP-141 `FunctionCall` action.
 */
export type DecodedFunctionCall = {
  methodName: string;
  args: Uint8Array;
  gas: bigint;
  deposit: bigint;
};

/**
 * Normalized view of a decoded delegate action used by verification.
 */
export type DecodedDelegateAction = {
  senderId: string;
  receiverId: string;
  /** Canonical NEAR public-key string, e.g. `ed25519:...`. */
  publicKey: string;
  /** Curve declared by the delegate public key. */
  curve: NearCurve;
  nonce: bigint;
  maxBlockHeight: bigint;
  /** Total number of delegated actions (spec §6 requires exactly one). */
  actionCount: number;
  /** The lone `FunctionCall` when the single action is one, else `null`. */
  functionCall: DecodedFunctionCall | null;
};

/**
 * Result of decoding a base64 Borsh `SignedDelegate`.
 */
export type DecodedSignedDelegate = {
  delegate: DecodedDelegateAction;
  /**
   * Verifies the NEP-366 signature over the delegate action against the
   * embedded public key. Returns `false` on any decoding/verification error
   * (fail closed).
   */
  verifySignature(): boolean;
};

/**
 * Loose shape of the Borsh-deserialized `SignedDelegate` (enum variants are
 * represented by `borsh` as single-key objects).
 */
type RawPublicKey = { ed25519Key?: { data: Uint8Array }; secp256k1Key?: { data: Uint8Array } };
type RawSignature = {
  ed25519Signature?: { data: Uint8Array };
  secp256k1Signature?: { data: Uint8Array };
};
type RawFunctionCall = { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint };
type RawAction = { functionCall?: RawFunctionCall };
type RawDelegateAction = {
  senderId: string;
  receiverId: string;
  actions: RawAction[];
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: RawPublicKey;
};
type RawSignedDelegate = { delegateAction: RawDelegateAction; signature: RawSignature };

/**
 * Extracts curve, numeric key type, and raw bytes from a decoded public key.
 *
 * @param pk - Borsh-decoded public key enum
 * @returns Curve name, numeric key type, and key bytes
 */
function readPublicKey(pk: RawPublicKey): { curve: NearCurve; keyType: number; data: Uint8Array } {
  // borsh@1 decodes fixed `u8` arrays as number[]; coerce to Uint8Array for
  // @near-js/crypto (base58 encoding) and @noble verification.
  if (pk.ed25519Key) {
    return { curve: "ed25519", keyType: 0, data: new Uint8Array(pk.ed25519Key.data) };
  }
  if (pk.secp256k1Key) {
    return { curve: "secp256k1", keyType: 1, data: new Uint8Array(pk.secp256k1Key.data) };
  }
  throw new Error("unsupported_public_key_type");
}

/**
 * Extracts curve and raw bytes from a decoded signature.
 *
 * @param sig - Borsh-decoded signature enum
 * @returns Curve name and signature bytes
 */
function readSignature(sig: RawSignature): { curve: NearCurve; data: Uint8Array } {
  if (sig.ed25519Signature) {
    return { curve: "ed25519", data: new Uint8Array(sig.ed25519Signature.data) };
  }
  if (sig.secp256k1Signature) {
    return { curve: "secp256k1", data: new Uint8Array(sig.secp256k1Signature.data) };
  }
  throw new Error("unsupported_signature_type");
}

/**
 * Decodes a base64 Borsh `SignedDelegate` (NEP-366) and exposes a normalized
 * view plus a closure that verifies its NEP-366 signature.
 *
 * Uses `@near-js/transactions` as the single source of truth for the Borsh
 * schema and the domain-separated signing preimage.
 *
 * @param b64 - base64-encoded Borsh `SignedDelegate`
 * @returns Normalized delegate action and signature verifier
 */
export function decodeSignedDelegateB64(b64: string): DecodedSignedDelegate {
  const raw = deserialize(SCHEMA.SignedDelegate, fromBase64(b64)) as RawSignedDelegate;
  const da = raw.delegateAction;

  const pub = readPublicKey(da.publicKey);
  const publicKey = new PublicKey({ keyType: pub.keyType, data: pub.data });
  const sig = readSignature(raw.signature);

  const actions = Array.isArray(da.actions) ? da.actions : [];
  const fc = actions.length === 1 ? actions[0].functionCall : undefined;
  const functionCall: DecodedFunctionCall | null = fc
    ? {
        methodName: fc.methodName,
        args: new Uint8Array(fc.args),
        gas: BigInt(fc.gas),
        deposit: BigInt(fc.deposit),
      }
    : null;

  const delegate: DecodedDelegateAction = {
    senderId: da.senderId,
    receiverId: da.receiverId,
    publicKey: publicKey.toString(),
    curve: pub.curve,
    nonce: BigInt(da.nonce),
    maxBlockHeight: BigInt(da.maxBlockHeight),
    actionCount: actions.length,
    functionCall,
  };

  return {
    delegate,
    verifySignature(): boolean {
      try {
        // The signing curve MUST match the declared key-type curve (spec §4).
        if (sig.curve !== pub.curve) {
          return false;
        }
        // NEP-366 preimage: serialize(prefix) ++ serialize(delegateAction),
        // then sha256, then verify against the embedded public key. Re-encoding
        // the decoded delegate action reproduces the exact signed bytes. The
        // Borsh-decoded shape matches SCHEMA.DelegateAction structurally.
        const message = encodeDelegateAction(da as unknown as DelegateAction);
        const hash = sha256(message);
        return publicKey.verify(hash, sig.data);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Parses and validates NEP-141 `ft_transfer` JSON args.
 *
 * @param args - Raw function-call argument bytes
 * @returns Parsed transfer args
 */
export function parseFtTransferArgs(args: Uint8Array): NearFtTransferArgs {
  const decoded = JSON.parse(new TextDecoder().decode(args)) as NearFtTransferArgs;
  if (typeof decoded.receiver_id !== "string" || decoded.receiver_id.length === 0) {
    throw new Error("invalid_ft_transfer_args_receiver_id");
  }
  if (typeof decoded.amount !== "string" || !/^\d+$/.test(decoded.amount)) {
    throw new Error("invalid_ft_transfer_args_amount");
  }
  return decoded;
}

/**
 * Deterministic `maxTimeoutSeconds` -> block-count mapping (spec §5):
 * `timeoutBlocks = max(1, ceil(maxTimeoutSeconds / estimatedBlockSeconds))`.
 *
 * @param maxTimeoutSeconds - Positive timeout budget in seconds
 * @returns Number of blocks the delegate window may span
 */
export function computeTimeoutBlocks(maxTimeoutSeconds: number): bigint {
  const blocks = Math.ceil(maxTimeoutSeconds / ESTIMATED_BLOCK_SECONDS);
  return BigInt(Math.max(1, blocks));
}

/**
 * Derives the duplicate-settlement cache key (spec §10): the hex SHA-256 of the
 * exact base64-decoded `signedDelegateAction` bytes.
 *
 * @param signedDelegateActionB64 - base64 Borsh `SignedDelegate`
 * @returns Hex-encoded SHA-256 digest
 */
export function settlementCacheKey(signedDelegateActionB64: string): string {
  return bytesToHex(sha256(fromBase64(signedDelegateActionB64)));
}

/**
 * Converts bytes to base64.
 *
 * @param bytes - Bytes to encode
 * @returns Base64 string
 */
export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let value = "";
  for (let i = 0; i < bytes.length; i++) {
    value += String.fromCharCode(bytes[i]);
  }
  return btoa(value);
}

/**
 * Converts a base64 string to bytes.
 *
 * @param value - Base64 string
 * @returns Decoded bytes
 */
export function fromBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  const decoded = atob(value);
  const result = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    result[i] = decoded.charCodeAt(i);
  }
  return result;
}
