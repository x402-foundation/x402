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

// AUTHORED OFFLINE — first CI run is the verification step.

import { describe, it, expect } from "vitest";
import {
  createVCXIssuer,
  issueCredential,
  getDidResolver,
  generateEd25519KeyPair,
  buildCredentialSubject,
  buildDelegation,
} from "../src/vcx";
import { trustedIssuer, principalDid } from "./vcx-test-utils";

describe("createVCXIssuer", () => {
  it("returns an Issuer with did, signer function, and EdDSA algorithm", () => {
    const issuer = createVCXIssuer(trustedIssuer);
    expect(issuer.did).toBe(trustedIssuer.did);
    expect(issuer.alg).toBe("EdDSA");
    expect(typeof issuer.signer).toBe("function");
  });

});

describe("issueCredential", () => {
  it("produces a JWT with the expected header, payload, and expiry", async () => {
    const subject = buildCredentialSubject({
      principalDid,
      claims: { kycLevel: "IdentityVerified", ageOver18: true },
      delegation: buildDelegation({ agentDid: "did:key:zAgent" }),
    });

    const { jwt, expiresAt } = await issueCredential({
      issuerConfig: trustedIssuer,
      subject,
      expiresInSeconds: 3600,
    });

    const parts = jwt.split(".");
    expect(parts.length).toBe(3);

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    expect(header.alg).toBe("EdDSA");

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    expect(payload.sub).toBe(principalDid);
    expect(payload.iss).toBe(trustedIssuer.did);
    expect(payload.vc.type).toContain("X402IdentityCredential");
    expect(payload.vc.credentialSubject.kycLevel).toBe("IdentityVerified");

    const expiresAtMs = Date.parse(expiresAt);
    const driftMs = Math.abs(expiresAtMs - (Date.now() + 3600 * 1000));
    expect(driftMs).toBeLessThan(5000);
  });

  it("rejects when private key hex is empty", async () => {
    const subject = buildCredentialSubject({
      principalDid,
      claims: {},
      delegation: buildDelegation({ agentDid: "did:key:zAgent" }),
    });
    await expect(
      issueCredential({
        issuerConfig: { did: trustedIssuer.did, privateKeyHex: "" },
        subject,
      })
    ).rejects.toThrow();
  });
});

describe("getDidResolver", () => {
  it("resolves a did:key identifier produced by generateEd25519KeyPair", async () => {
    const kp = generateEd25519KeyPair();
    const resolver = getDidResolver();
    const result = await resolver.resolve(kp.did);
    expect(result.didDocument?.id).toBe(kp.did);
    expect((result.didDocument?.verificationMethod ?? []).length).toBeGreaterThan(0);
  });

  it("returns the same resolver instance on subsequent calls", () => {
    expect(getDidResolver()).toBe(getDidResolver());
  });

  it("returns notFound for a malformed did:key identifier", async () => {
    const resolver = getDidResolver();
    const result = await resolver.resolve("did:key:zNotAValidMulticodecKey");
    expect(result.didResolutionMetadata.error).toBe("notFound");
  });
});
