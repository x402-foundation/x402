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

import { gzipSync } from "zlib";
import { createVerifiableCredentialJwt, type Issuer } from "did-jwt-vc";
import { EdDSASigner } from "did-jwt";
import {
  DisclosureTier,
  generateEd25519KeyPair,
  type IssuerConfig,
  type PrincipalClaims,
  type PaymentSourceLayer,
  type IdentityRequirements,
  type VCXCredentialSubject,
} from "../src/vcx";

// -----------------------------------------------------------------
// Stable demo issuer + principal fixtures (formerly test/fixtures/keys.ts).
// -----------------------------------------------------------------

export const trustedIssuer: IssuerConfig = {
  did: "did:key:z6MkehBvJQrFXNY3jYcRpXFjbhUrve8ap2a3vwZC91HPpNfE",
  privateKeyHex: "ec647ec7c32eaabc40c6b3d5ccfc9da4ec034fcb52628d1f2c98d26560d69645",
};

export const principalDid = "did:web:demo.example:user:TEST123";

export const principalClaims: PrincipalClaims = {
  kycLevel: "IdentityVerified",
  ageOver18: true,
  emailVerified: true,
  paymentsEnabled: true,
  accountType: "PERSONAL",
};

export const paymentSource: PaymentSourceLayer = {
  accountId: "eip155:8453:0xA11CE0000000000000000000000000000000FACE",
  sourceId: "0xA11CE0000000000000000000000000000000FACE",
  network: "eip155:8453",
};

export const requirements: IdentityRequirements = {
  protocol: "x402-vcx-v1",
  disclosureTier: DisclosureTier.SelectiveClaims,
  requiredClaims: ["kycLevel", "ageOver18"],
  minKycLevel: "IdentityVerified",
  acceptedIssuers: [trustedIssuer.did],
};

/**
 * Generate a fresh untrusted issuer for "not in acceptedIssuers" negative tests.
 *
 * @returns A new issuer config with a freshly generated Ed25519 keypair.
 */
export function newIssuer(): IssuerConfig {
  const kp = generateEd25519KeyPair();
  return { did: kp.did, privateKeyHex: kp.privateKeyHex };
}

// -----------------------------------------------------------------
// Bitstring Status List v1.0 test helpers (formerly
// test/fixtures/status-lists.ts).
// -----------------------------------------------------------------

const SECONDS = 1;
const HOUR = 60 * 60 * SECONDS;
const DAY = 24 * HOUR;

/**
 * Status-list URL the fixture credentials reference. Tests mock `fetch`
 * to return the status list JWT for this URL.
 */
export const STATUS_LIST_URL = "https://example.test/credentials/status/1";

/**
 * Build a Bitstring Status List v1.0 `encodedList` value given the
 * indices that should be revoked (bit set to 1). Default list size is
 * smaller than the spec §13.6 recommended 131,072-bit minimum for test
 * speed; production issuers use larger lists for herd-based privacy.
 *
 * @param opts - Options for building the encoded list.
 * @param opts.revokedIndices - Bit indices to set to 1 (revoked).
 * @param opts.sizeBits - Total bit length of the list (defaults to 16384).
 * @returns The gzip-compressed, base64url-encoded status list with the multibase `u` prefix.
 */
export function buildEncodedList(opts: { revokedIndices: number[]; sizeBits?: number }): string {
  const sizeBits = opts.sizeBits ?? 16384;
  const bytes = new Uint8Array(Math.ceil(sizeBits / 8));
  for (const idx of opts.revokedIndices) {
    if (idx < 0 || idx >= sizeBits) {
      throw new Error(`revokedIndex ${idx} is outside size ${sizeBits}`);
    }
    const byteIdx = Math.floor(idx / 8);
    const bitIdx = idx % 8;
    bytes[byteIdx] |= 1 << (7 - bitIdx);
  }
  const gz = gzipSync(Buffer.from(bytes));
  return "u" + gz.toString("base64url");
}

/**
 * Build a did-jwt-vc `Issuer` (EdDSA signer) from an issuer config.
 *
 * @param config - The issuer config holding the DID and hex private key.
 * @returns A did-jwt-vc Issuer ready to sign credentials.
 */
function makeIssuer(config: IssuerConfig): Issuer {
  const privateKeyBytes = Uint8Array.from(Buffer.from(config.privateKeyHex, "hex"));
  return {
    did: config.did,
    signer: EdDSASigner(privateKeyBytes),
    alg: "EdDSA",
  };
}

/**
 * Issue a signed Bitstring Status List credential JWT for the fixture status list URL.
 *
 * @param opts - Options for issuing the status list credential.
 * @param opts.issuerConfig - The issuer that signs the status list credential.
 * @param opts.encodedList - The encoded bitstring list to embed in the credential.
 * @returns A signed status list credential JWT.
 */
export async function issueStatusListCredential(opts: {
  issuerConfig: IssuerConfig;
  encodedList: string;
}): Promise<string> {
  const issuer = makeIssuer(opts.issuerConfig);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: STATUS_LIST_URL,
    nbf: now,
    exp: now + 30 * DAY,
    vc: {
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://www.w3.org/ns/credentials/status/v1",
      ],
      type: ["VerifiableCredential", "BitstringStatusListCredential"],
      credentialSubject: {
        id: `${STATUS_LIST_URL}#list`,
        type: "BitstringStatusList",
        statusPurpose: "revocation",
        encodedList: opts.encodedList,
      },
    },
  };
  return createVerifiableCredentialJwt(payload, issuer);
}

/**
 * Issue a long-lived identity credential JWT carrying a Bitstring Status List entry.
 *
 * @param opts - Options for issuing the long-lived credential.
 * @param opts.issuerConfig - The issuer that signs the credential.
 * @param opts.subject - The credential subject to embed.
 * @param opts.statusListIndex - The status list index referenced by the credentialStatus entry.
 * @param opts.lifetimeSeconds - Credential lifetime in seconds (defaults to 48 hours).
 * @param opts.credentialStatusOverride - Replaces the default credentialStatus block when provided.
 * @returns A signed long-lived credential JWT.
 */
export async function issueLongLivedCredential(opts: {
  issuerConfig: IssuerConfig;
  subject: VCXCredentialSubject;
  statusListIndex: number;
  lifetimeSeconds?: number;
  credentialStatusOverride?: Record<string, unknown>;
}): Promise<string> {
  const issuer = makeIssuer(opts.issuerConfig);
  const now = Math.floor(Date.now() / 1000);
  const lifetimeSeconds = opts.lifetimeSeconds ?? 48 * HOUR;
  const payload = {
    sub: opts.subject.id,
    nbf: now,
    exp: now + lifetimeSeconds,
    vc: {
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://x402.org/credentials/identity/v1",
      ],
      type: ["VerifiableCredential", "X402IdentityCredential"],
      credentialSubject: opts.subject,
      credentialStatus: opts.credentialStatusOverride ?? {
        id: `${STATUS_LIST_URL}#${opts.statusListIndex}`,
        type: "BitstringStatusListEntry",
        statusPurpose: "revocation",
        statusListIndex: String(opts.statusListIndex),
        statusListCredential: STATUS_LIST_URL,
      },
    },
  };
  return createVerifiableCredentialJwt(payload, issuer);
}

/**
 * Issue a short-lived (12h) identity credential that improperly carries a
 * credentialStatus field, used to exercise the short-lived-profile rejection path.
 *
 * @param opts - Options for issuing the short-lived credential.
 * @param opts.issuerConfig - The issuer that signs the credential.
 * @param opts.subject - The credential subject to embed.
 * @returns A signed short-lived credential JWT that contains a credentialStatus block.
 */
export async function issueShortLivedCredentialWithStatus(opts: {
  issuerConfig: IssuerConfig;
  subject: VCXCredentialSubject;
}): Promise<string> {
  const issuer = makeIssuer(opts.issuerConfig);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: opts.subject.id,
    nbf: now,
    exp: now + 12 * HOUR,
    vc: {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      type: ["VerifiableCredential", "X402IdentityCredential"],
      credentialSubject: opts.subject,
      credentialStatus: {
        id: `${STATUS_LIST_URL}#5`,
        type: "BitstringStatusListEntry",
        statusPurpose: "revocation",
        statusListIndex: "5",
        statusListCredential: STATUS_LIST_URL,
      },
    },
  };
  return createVerifiableCredentialJwt(payload, issuer);
}

/**
 * Build a `fetch` mock that serves the given body for the fixture status list
 * URL and 404s for everything else, tracking the number of calls made.
 *
 * @param opts - Options for the fetch mock.
 * @param opts.body - The response body returned for the status list URL.
 * @param opts.cacheControl - Optional `cache-control` header value to include.
 * @returns A fetch-compatible function exposing a `calls` counter.
 */
export function mockStatusListFetch(opts: {
  body: string;
  cacheControl?: string;
}): typeof fetch & { calls: number } {
  const fn = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    fn.calls += 1;
    if (url === STATUS_LIST_URL) {
      const headers = new Headers();
      if (opts.cacheControl) {
        headers.set("cache-control", opts.cacheControl);
      }
      return new Response(opts.body, { status: 200, headers });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch & { calls: number };
  fn.calls = 0;
  return fn;
}
