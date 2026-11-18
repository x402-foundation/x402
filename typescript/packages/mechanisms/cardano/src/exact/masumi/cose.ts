import { Address, CBOR, COSE, Credential } from "@evolution-sdk/evolution";

/**
 * Verification of the seller's CIP-8 authorization over `termsDigest`.
 *
 * The seller calls CIP-30 `signData(sellerAddress, lowercaseHex(termsDigest))`;
 * `extra.referenceKey` carries the complete CBOR `COSE_Key` and
 * `extra.referenceSignature` the complete CBOR `COSE_Sign1`. The attached
 * payload is the 32-byte digest, `hashed` is `false`, and the external AAD is
 * empty.
 *
 * The address binding — `Blake2b-224(publicKey)` equal to the seller's
 * payment-key credential — is what ties the signature to the *address* rather
 * than to an arbitrary key, and is never skipped.
 */

/** COSE_Key parameter labels (RFC 8152 §7.1 and §13.2). */
const KEY_LABEL_KTY = 1n;
const KEY_LABEL_KID = 2n;
const KEY_LABEL_ALG = 3n;
const KEY_LABEL_CRV = -1n;
const KEY_LABEL_X = -2n;
const KEY_LABEL_D = -4n;

/** `kty = OKP`, `alg = EdDSA`, `crv = Ed25519`. */
const KTY_OKP = BigInt(COSE.Label.KeyType.OKP);
const ALG_EDDSA = BigInt(COSE.Label.AlgorithmId.EdDSA);
const CRV_ED25519 = BigInt(COSE.Label.CurveType.Ed25519);

/** Ed25519 public keys are exactly 32 bytes. */
const ED25519_PUBLIC_KEY_BYTES = 32;

/**
 * Reads a text-labelled COSE header. `HeaderMap.header()` looks up by
 * reference, so labels are matched structurally instead.
 *
 * @param headers - The COSE header map.
 * @param label - The text label to look for.
 * @returns The header value, or `undefined` when absent.
 */
function textHeader(headers: COSE.Header.HeaderMap, label: string): unknown {
  for (const [key, value] of headers.headers.entries()) {
    if (key.kind === COSE.Label.LabelKind.Text && key.value === label) return value;
  }
  return undefined;
}

/**
 * Whether two byte arrays are equal.
 *
 * @param a - The first array.
 * @param b - The second array.
 * @returns True when both have the same length and contents.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * Structurally validates the `COSE_Key`: `kty = OKP`, `alg = EdDSA`,
 * `crv = Ed25519`, a 32-byte public key, and no private material.
 *
 * @param keyBytes - The complete CBOR `COSE_Key`.
 * @returns The `kid`, or `undefined` when absent; `null` when the key is invalid.
 */
function validateCoseKey(keyBytes: Uint8Array): { kid?: Uint8Array } | null {
  const decoded = CBOR.internalDecodeSync(keyBytes);
  if (!(decoded instanceof Map)) return null;
  const map = decoded as Map<unknown, unknown>;
  if (map.get(KEY_LABEL_KTY) !== KTY_OKP) return null;
  if (map.get(KEY_LABEL_ALG) !== ALG_EDDSA) return null;
  if (map.get(KEY_LABEL_CRV) !== CRV_ED25519) return null;
  // A reference key is a public key; private material must never travel in it.
  if (map.has(KEY_LABEL_D)) return null;
  const publicKey = map.get(KEY_LABEL_X);
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    return null;
  }
  const kid = map.get(KEY_LABEL_KID);
  return kid instanceof Uint8Array ? { kid } : {};
}

/**
 * Verifies the seller's COSE authorization over `termsDigest`.
 *
 * Total: any structural, policy or cryptographic failure returns `false` rather
 * than throwing, so the caller can turn it into a single rejection reason.
 *
 * @param referenceKeyHex - Complete CBOR `COSE_Key` as hex (`extra.referenceKey`).
 * @param referenceSignatureHex - Complete CBOR `COSE_Sign1` as hex.
 * @param sellerAddressBech32 - The seller address the signature must bind to.
 * @param termsDigestHex - The 32-byte `termsDigest` as lowercase hex.
 * @returns True when every check in the spec's seller-signed-terms list passes.
 */
export function verifySellerTermsSignature(
  referenceKeyHex: string,
  referenceSignatureHex: string,
  sellerAddressBech32: string,
  termsDigestHex: string,
): boolean {
  try {
    const keyBytes = Uint8Array.from(Buffer.from(referenceKeyHex, "hex"));
    const signatureBytes = Uint8Array.from(Buffer.from(referenceSignatureHex, "hex"));

    const key = validateCoseKey(keyBytes);
    if (!key) return false;

    const coseSign1 = COSE.COSESign1.coseSign1FromCBORBytes(signatureBytes);
    // `hashed` MUST be present and false: with a hashed payload a signature over
    // the 28-byte blake2b digest would stand in for one over `termsDigest`.
    if (textHeader(coseSign1.headers.unprotected, "hashed") !== false) return false;

    // Equal `kid` values when both are present.
    const signatureKid = coseSign1.headers.protected.keyId();
    if (key.kid !== undefined && signatureKid !== undefined && !bytesEqual(key.kid, signatureKid)) {
      return false;
    }

    // A script payment credential can never be proven by a single Ed25519 key.
    const addressHex = Address.toHex(Address.fromBech32(sellerAddressBech32));
    const credential = Address.getPaymentCredential(addressHex);
    if (credential === undefined || credential._tag !== "KeyHash") return false;

    // Covers the attached payload, the protected `address` and `alg` headers,
    // the Blake2b-224 address binding and the Ed25519 `Sig_structure`, verified
    // with an empty external AAD.
    return COSE.SignData.verifyData(
      addressHex,
      Credential.toHex(credential),
      Uint8Array.from(Buffer.from(termsDigestHex, "hex")),
      { signature: signatureBytes, key: keyBytes },
    );
  } catch {
    return false;
  }
}
