import * as crypto from "crypto";
import type { JWSSigner } from "@x402/extensions/offer-receipt";

export interface SignerWithPublicKey {
  signer: JWSSigner;
  publicKeyJwk: JsonWebKey;
}

/**
 * Create a JWS signer from a base64-encoded PKCS#8 private key
 *
 * For production, use a proper key management solution (HSM, KMS, etc.)
 * This is a simple implementation for demonstration purposes.
 *
 * @param privateKeyBase64 - Base64-encoded PKCS#8 private key
 * @param kid - Key identifier DID URL
 * @returns SignerWithPublicKey containing the signer and public key JWK
 */
export function createJWSSignerFromPrivateKey(
  privateKeyBase64: string,
  kid: string,
): SignerWithPublicKey {
  // Decode base64 and check if it's PEM or DER format
  const decoded = Buffer.from(privateKeyBase64, "base64").toString("utf8");
  const isPem = decoded.includes("-----BEGIN");

  let privateKeyPem: string;
  if (isPem) {
    // Already PEM format (base64-encoded PEM)
    privateKeyPem = decoded;
  } else {
    // Raw DER format, wrap in PEM headers
    privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBase64}\n-----END PRIVATE KEY-----`;
  }

  const keyObject = crypto.createPrivateKey(privateKeyPem);
  const publicKeyJwk = keyObject.export({ format: "jwk" }) as JsonWebKey;
  // Remove private key component
  delete (publicKeyJwk as Record<string, unknown>).d;

  const signer: JWSSigner = {
    kid,
    format: "jws",
    algorithm: "ES256",
    async sign(payload: Uint8Array): Promise<string> {
      const sign = crypto.createSign("SHA256");
      sign.update(payload);
      const signature = sign.sign(privateKeyPem);
      // Convert DER signature to raw r||s format for JWS
      const rawSignature = derToRaw(signature);
      return Buffer.from(rawSignature).toString("base64url");
    },
  };

  return { signer, publicKeyJwk };
}

/**
 * Convert DER-encoded ECDSA signature to raw r||s format
 *
 * @param derSignature - DER-encoded signature buffer
 * @returns Raw signature as Uint8Array (64 bytes for P-256)
 */
function derToRaw(derSignature: Buffer): Uint8Array {
  // DER format: 0x30 [total-length] 0x02 [r-length] [r] 0x02 [s-length] [s]
  let offset = 2; // Skip 0x30 and total length

  // Read r
  if (derSignature[offset] !== 0x02) throw new Error("Invalid DER signature");
  offset++;
  const rLength = derSignature[offset];
  offset++;
  let r = derSignature.subarray(offset, offset + rLength);
  offset += rLength;

  // Read s
  if (derSignature[offset] !== 0x02) throw new Error("Invalid DER signature");
  offset++;
  const sLength = derSignature[offset];
  offset++;
  let s = derSignature.subarray(offset, offset + sLength);

  // Remove leading zeros and pad to 32 bytes
  if (r.length > 32) r = r.subarray(r.length - 32);
  if (s.length > 32) s = s.subarray(s.length - 32);

  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length);
  raw.set(s, 64 - s.length);

  return raw;
}
