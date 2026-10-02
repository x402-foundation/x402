import { PrivateKey, PublicKey, type Key } from "@hiero-ledger/sdk";
import { bytesToHex, getAddress, hexToBytes, recoverAddress, toHex } from "viem";
import { sign as signSecp256k1 } from "viem/accounts";
import { parseMirrorKey, type MirrorAccountKey } from "../signer";
import { fetchJson } from "../preflight";
import type { HederaKeyType } from "./types";

export type { HederaKeyType } from "./types";

/**
 * Maps the Hiero SDK key `type` string to a {@link HederaKeyType}.
 *
 * @param key - Hiero SDK private or public key.
 * @returns The key algorithm.
 */
export function keyTypeOf(key: PrivateKey | PublicKey): HederaKeyType {
  const type = String(key.type).toUpperCase();
  return type.includes("25519") ? "ED25519" : "ECDSA_SECP256K1";
}

/**
 * Signs a 32-byte digest with a Hedera account key in the form the Hedera Account Service
 * (`isAuthorizedRaw`) and the escrow contract expect:
 * - ED25519: the raw 64-byte signature over the digest bytes.
 * - ECDSA secp256k1: the 65-byte `r || s || v` recoverable signature over the digest (no extra hashing).
 *
 * @param key - Hiero SDK private key of the signing account.
 * @param digest - 32-byte hex digest (EIP-712 or deposit-authorization digest).
 * @returns Hex-encoded raw signature.
 */
export async function signDigestWithPrivateKey(
  key: PrivateKey,
  digest: `0x${string}`,
): Promise<`0x${string}`> {
  assertDigest(digest);
  if (keyTypeOf(key) === "ED25519") {
    return bytesToHex(key.sign(hexToBytes(digest)));
  }
  // The SDK's ECDSA `sign` keccak-hashes its input; HAS verifies `ecrecover(digest)` directly.
  return signSecp256k1({ hash: digest, privateKey: toHex(key.toBytesRaw()), to: "hex" });
}

/** Account signing key resolved from the network. */
export type ResolvedSigningKey = {
  keyType: HederaKeyType;
  publicKey: PublicKey;
  /** EVM address derived from the public key (ECDSA only). */
  derivedEvmAddress?: `0x${string}`;
};

/** Signing key resolution outcome. */
export type SigningKeyResolution =
  | { ok: true; key: ResolvedSigningKey }
  | {
      ok: false;
      reason: "account_not_found" | "unsupported_key" | "resolution_failed";
      message: string;
    };

/**
 * Verifies a raw Hedera account signature over a 32-byte digest off-chain, mirroring the
 * on-chain `isAuthorizedRaw` rules for single primitive keys.
 *
 * @param params - Verification inputs.
 * @param params.key - The account's resolved signing key.
 * @param params.digest - 32-byte hex digest that was signed.
 * @param params.signature - Hex signature (64 bytes ED25519, 65 bytes ECDSA).
 * @returns `true` when the signature is valid for the key.
 */
export async function verifyDigestSignature(params: {
  key: ResolvedSigningKey;
  digest: `0x${string}`;
  signature: `0x${string}`;
}): Promise<boolean> {
  const { key, digest, signature } = params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest) || !/^0x[0-9a-fA-F]*$/.test(signature)) {
    return false;
  }
  const sigBytes = hexToBytes(signature);
  try {
    if (key.keyType === "ED25519") {
      if (sigBytes.length !== 64) return false;
      return key.publicKey.verify(hexToBytes(digest), sigBytes);
    }
    if (sigBytes.length !== 65 || !key.derivedEvmAddress) return false;
    const recovered = await recoverAddress({ hash: digest, signature });
    return recovered.toLowerCase() === key.derivedEvmAddress.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Converts a Hiero SDK `Key` into a {@link SigningKeyResolution}. Only single primitive keys are
 * supported; `KeyList` / threshold / contract keys are rejected (HAS `isAuthorizedRaw` cannot
 * validate them either).
 *
 * @param key - Parsed account key (or `null` when the account has none / an unknown type).
 * @returns Resolution result.
 */
export function resolveSigningKeyFromKey(key: Key | null): SigningKeyResolution {
  if (!(key instanceof PublicKey)) {
    return {
      ok: false,
      reason: "unsupported_key",
      message: "account key must be a single ED25519 or ECDSA secp256k1 key",
    };
  }
  const keyType = keyTypeOf(key);
  return {
    ok: true,
    key: {
      keyType,
      publicKey: key,
      ...(keyType === "ECDSA_SECP256K1"
        ? { derivedEvmAddress: getAddress(`0x${key.toEvmAddress().replace(/^0x/, "")}`) }
        : {}),
    },
  };
}

/**
 * Parses a Mirror Node account `key` field into a signing key resolution.
 *
 * @param mirrorKey - The `key` object from `/api/v1/accounts/{id}`.
 * @returns Resolution result.
 */
export function resolveSigningKeyFromMirrorKey(
  mirrorKey: MirrorAccountKey["key"],
): SigningKeyResolution {
  try {
    return resolveSigningKeyFromKey(parseMirrorKey(mirrorKey));
  } catch (error) {
    return {
      ok: false,
      reason: "resolution_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Options for {@link createAccountKeyResolver}. */
export type AccountKeyResolverOptions = {
  /** Mirror Node REST base URL (no trailing slash). */
  mirrorNodeUrl: string;
  /** Max cached entries (default 1000). */
  cacheSize?: number;
  /** Cache TTL in ms (default 5 minutes). Account keys rarely rotate. */
  cacheTtlMs?: number;
};

/** Resolves and caches account signing keys by account id or EVM address. */
export type AccountKeyResolver = (accountIdOrEvmAddress: string) => Promise<SigningKeyResolution>;

/**
 * Builds a cached Mirror Node-backed {@link AccountKeyResolver}.
 *
 * @param options - Mirror Node URL and cache tuning.
 * @returns Resolver function.
 */
export function createAccountKeyResolver(options: AccountKeyResolverOptions): AccountKeyResolver {
  const cacheSize = options.cacheSize ?? 1000;
  const ttl = options.cacheTtlMs ?? 5 * 60 * 1000;
  const cache = new Map<string, { at: number; value: SigningKeyResolution }>();

  return async (accountIdOrEvmAddress: string) => {
    const cacheKey = accountIdOrEvmAddress.toLowerCase();
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttl) {
      return hit.value;
    }

    let value: SigningKeyResolution;
    try {
      const account = await fetchJson<MirrorAccountKey>(
        `${options.mirrorNodeUrl}/api/v1/accounts/${encodeURIComponent(accountIdOrEvmAddress)}`,
      );
      value = resolveSigningKeyFromMirrorKey(account.key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      value = /status 404/.test(message)
        ? { ok: false, reason: "account_not_found", message }
        : { ok: false, reason: "resolution_failed", message };
      // Do not cache transient failures.
      return value;
    }

    if (cache.size >= cacheSize) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  };
}

/**
 * Asserts a value is a 32-byte hex digest.
 *
 * @param digest - Value to check.
 */
function assertDigest(digest: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) {
    throw new Error("digest must be a 32-byte hex string");
  }
}

/**
 * Parses a private key string without the ambiguity of `PrivateKey.fromString`, which treats a
 * raw 32-byte hex (e.g. `0x`-prefixed ECDSA keys exported from EVM wallets) as ED25519.
 *
 * @param raw - DER hex, raw hex (optionally `0x`-prefixed), or the SDK string format.
 * @param keyType - Known key algorithm; when omitted, DER-encoded strings self-describe and raw
 *   `0x`-prefixed hex is assumed to be ECDSA secp256k1, other raw hex ED25519.
 * @returns Parsed private key.
 */
export function parseHederaPrivateKey(raw: string, keyType?: HederaKeyType): PrivateKey {
  const value = raw.trim();
  if (keyType === "ECDSA_SECP256K1") return PrivateKey.fromStringECDSA(value);
  if (keyType === "ED25519") return PrivateKey.fromStringED25519(value);
  const hex = value.replace(/^0x/, "");
  if (/^30[0-9a-fA-F]+$/.test(hex) && hex.length > 64) {
    return PrivateKey.fromStringDer(hex);
  }
  if (value.startsWith("0x") && hex.length === 64) {
    return PrivateKey.fromStringECDSA(hex);
  }
  return PrivateKey.fromString(value);
}
