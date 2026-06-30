/**
 * Copyright 2026 PayPal Holdings, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createVerifiableCredentialJwt } from "did-jwt-vc";
import { EdDSASigner } from "did-jwt";
import type { Issuer } from "did-jwt-vc";
import type { IssuerConfig, VCXCredentialSubject } from "../types";
import { buildSdIssuerSubject, composeSdJwt } from "../envelope/sdjwtvc";

/**
 * Default credential lifetime (24 hours). Matches the short-lived
 * revocation profile in spec §11.1; long-lived issuance MUST set
 * `expiresInSeconds` above 86400 AND attach a `credentialStatus` per
 * spec §11.2 (issuer's responsibility — the SDK doesn't auto-construct
 * Bitstring Status List entries).
 */
const DEFAULT_EXPIRES_IN_SECONDS = 24 * 60 * 60;

/**
 * Build a did-jwt-vc {@link Issuer} from a VCX issuer configuration,
 * decoding the hex-encoded Ed25519 private key into an EdDSA signer.
 *
 * @param config - The issuer configuration, including its DID and hex private key.
 * @returns An {@link Issuer} ready to sign verifiable credentials.
 */
export function createVCXIssuer(config: IssuerConfig): Issuer {
  const privateKeyBytes = Uint8Array.from(Buffer.from(config.privateKeyHex, "hex"));
  return {
    did: config.did,
    signer: EdDSASigner(privateKeyBytes),
    alg: "EdDSA",
  };
}

export interface IssueCredentialOptions {
  issuerConfig: IssuerConfig;
  subject: VCXCredentialSubject;
  expiresInSeconds?: number;
  /**
   * Credential serialisation format per spec §6.1. Defaults to `"jwt-vc"`.
   * `"sd-jwt-vc"` emits an SD-JWT VC presentation suitable for spec §12
   * Tier 1 selective disclosure; the issuer-signed payload commits to
   * digests of every claim listed in `selectivelyDisclosable`, and the
   * returned string includes the matching disclosures.
   */
  format?: "jwt-vc" | "sd-jwt-vc";
  /**
   * Subject claim names that should be selectively disclosable when
   * `format === "sd-jwt-vc"`. Each listed claim is replaced in the
   * issuer-signed payload with a `_sd` digest commitment; the matching
   * `[salt, name, value]` disclosure is appended to the SD-JWT format.
   * Claims not listed here are always disclosed (treated as plain
   * fields). Ignored when `format === "jwt-vc"`.
   */
  selectivelyDisclosable?: readonly string[];
}

/**
 * Issue a signed X402 identity verifiable credential for the given
 * subject. Emits a standard `jwt-vc` by default, or an `sd-jwt-vc` with
 * selective-disclosure digest commitments when requested, returning the
 * serialised credential alongside its computed expiry and format.
 *
 * @param opts - The issuance options.
 * @param opts.issuerConfig - The issuer configuration used to sign the credential.
 * @param opts.subject - The credential subject to embed.
 * @param opts.expiresInSeconds - Credential lifetime in seconds; defaults to 24 hours.
 * @param opts.format - The serialisation format (`"jwt-vc"` or `"sd-jwt-vc"`); defaults to `"jwt-vc"`.
 * @param opts.selectivelyDisclosable - Subject claim names to make selectively disclosable under `sd-jwt-vc`.
 * @returns The serialised credential, its ISO 8601 expiry, and the emitted format.
 */
export async function issueCredential(
  opts: IssueCredentialOptions,
): Promise<{ jwt: string; expiresAt: string; format: "jwt-vc" | "sd-jwt-vc" }> {
  const issuer = createVCXIssuer(opts.issuerConfig);
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = opts.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
  const expiresAt = new Date((now + expiresIn) * 1000).toISOString();
  const format = opts.format ?? "jwt-vc";

  if (format === "jwt-vc") {
    const vcPayload = {
      sub: opts.subject.id,
      nbf: now,
      exp: now + expiresIn,
      vc: {
        "@context": [
          "https://www.w3.org/2018/credentials/v1",
          "https://x402.org/credentials/identity/v1",
        ],
        type: ["VerifiableCredential", "X402IdentityCredential"],
        credentialSubject: opts.subject,
      },
    };
    const jwt = await createVerifiableCredentialJwt(vcPayload, issuer);
    return { jwt, expiresAt, format };
  }

  // SD-JWT VC path. Split the subject into base (always-disclosed)
  // and disclosable; the issuer-signed payload sees the base subject
  // plus a `_sd` array of digest commitments for the disclosable
  // claims. Disclosures are concatenated onto the JWT with `~`.
  const { issuerSubject, disclosures } = buildSdIssuerSubject({
    subject: opts.subject as unknown as Record<string, unknown>,
    selectivelyDisclosable: opts.selectivelyDisclosable ?? [],
  });
  const vcPayload = {
    sub: opts.subject.id,
    nbf: now,
    exp: now + expiresIn,
    vc: {
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://x402.org/credentials/identity/v1",
      ],
      type: ["VerifiableCredential", "X402IdentityCredential"],
      credentialSubject: issuerSubject,
    },
  };
  const jwt = await createVerifiableCredentialJwt(vcPayload, issuer);
  return { jwt: composeSdJwt(jwt, disclosures), expiresAt, format };
}
