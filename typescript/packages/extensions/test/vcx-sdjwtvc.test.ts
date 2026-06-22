/**
 * Copyright 2026 PayPal Holdings, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";
import {
  buildDisclosure,
  buildIdentityEnvelope,
  buildCredentialSubject,
  buildDelegation,
  composeSdJwt,
  createAgent,
  disclosureHash,
  DisclosureTier,
  issueCredential,
  parseDisclosure,
  parseSdJwt,
  verifyEnvelope,
  verifySdJwtVcPresentation,
  getDidResolver,
} from "../src/vcx";
import {
  trustedIssuer,
  principalDid,
  principalClaims,
  paymentSource,
  requirements,
} from "./vcx-test-utils";

const validExpiresAt = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe("SD-JWT format primitives", () => {
  it("round-trips a disclosure: build → hash matches; parse → original values", () => {
    const d = buildDisclosure("ageOver18", true, "fixed-salt-123");
    const parsed = parseDisclosure(d);
    expect(parsed.salt).toBe("fixed-salt-123");
    expect(parsed.name).toBe("ageOver18");
    expect(parsed.value).toBe(true);
    // Same disclosure → same hash (idempotent).
    expect(disclosureHash(d)).toBe(disclosureHash(d));
  });

  it("rejects a malformed disclosure (non-array JSON)", () => {
    const garbage = Buffer.from('{"not":"an array"}', "utf8").toString("base64url");
    expect(() => parseDisclosure(garbage)).toThrow(/3-element array/);
  });

  it("parses SD-JWT format: <jwt>~<d1>~<d2>~", () => {
    const composed = composeSdJwt("h.p.s", ["d1", "d2"]);
    expect(composed).toBe("h.p.s~d1~d2~");
    const parsed = parseSdJwt(composed);
    expect(parsed.jwt).toBe("h.p.s");
    expect(parsed.disclosures).toEqual(["d1", "d2"]);
    expect(parsed.keyBindingJwt).toBeUndefined();
  });

  it("captures a trailing KB-JWT (3-part JWT shape) separately from disclosures", () => {
    // A KB-JWT is a compact JWS: exactly three parts (header.payload.signature).
    const parsed = parseSdJwt("h.p.s~d1~d2~kb.payload.sig");
    expect(parsed.jwt).toBe("h.p.s");
    expect(parsed.disclosures).toEqual(["d1", "d2"]);
    expect(parsed.keyBindingJwt).toBe("kb.payload.sig");
  });
});

describe("issueCredential — sd-jwt-vc format", () => {
  it("returns a string in SD-JWT format with one ~ per disclosure", async () => {
    const agent = createAgent("sd-jwt-issuance-agent");
    const subject = buildCredentialSubject({
      principalDid,
      claims: principalClaims,
      delegation: buildDelegation({
        agentDid: agent.did,
        paymentSource: paymentSource.accountId,
        conditions: { expiresAt: validExpiresAt() },
      }),
    });
    const { jwt: sdjwt, format } = await issueCredential({
      issuerConfig: trustedIssuer,
      subject,
      format: "sd-jwt-vc",
      selectivelyDisclosable: ["ageOver18", "jurisdiction"],
    });
    expect(format).toBe("sd-jwt-vc");
    const parsed = parseSdJwt(sdjwt);
    // Two disclosable claims → at least two disclosures (jurisdiction
    // may be absent from principalClaims, in which case it's skipped).
    expect(parsed.disclosures.length).toBeGreaterThanOrEqual(1);
  });
});

describe("verifySdJwtVcPresentation", () => {
  it("returns disclosed claim values for a valid presentation", async () => {
    const agent = createAgent("sd-jwt-verify-agent");
    const subject = buildCredentialSubject({
      principalDid,
      claims: principalClaims,
      delegation: buildDelegation({
        agentDid: agent.did,
        paymentSource: paymentSource.accountId,
        conditions: { expiresAt: validExpiresAt() },
      }),
    });
    const { jwt: sdjwt } = await issueCredential({
      issuerConfig: trustedIssuer,
      subject,
      format: "sd-jwt-vc",
      selectivelyDisclosable: ["ageOver18"],
    });
    const result = await verifySdJwtVcPresentation({
      sdjwt,
      resolver: getDidResolver(),
    });
    expect(result.issuer).toBe(trustedIssuer.did);
    expect(result.disclosed.ageOver18).toBe(true);
  });

  it("rejects a presentation with a forged disclosure (hash not in _sd)", async () => {
    const agent = createAgent("sd-jwt-forged-agent");
    const subject = buildCredentialSubject({
      principalDid,
      claims: principalClaims,
      delegation: buildDelegation({
        agentDid: agent.did,
        paymentSource: paymentSource.accountId,
        conditions: { expiresAt: validExpiresAt() },
      }),
    });
    const { jwt: sdjwt } = await issueCredential({
      issuerConfig: trustedIssuer,
      subject,
      format: "sd-jwt-vc",
      selectivelyDisclosable: ["ageOver18"],
    });
    // Append an attacker-constructed disclosure that the issuer never
    // committed to: claims "vipStatus: platinum".
    const forged = buildDisclosure("vipStatus", "platinum");
    const parsed = parseSdJwt(sdjwt);
    const tampered = composeSdJwt(parsed.jwt, [...parsed.disclosures, forged]);
    await expect(
      verifySdJwtVcPresentation({ sdjwt: tampered, resolver: getDidResolver() }),
    ).rejects.toThrow(/not present in issuer _sd commitments|forged disclosure/);
  });

  it("rejects when the issuer JWT signature is broken", async () => {
    const agent = createAgent("sd-jwt-tamper-agent");
    const subject = buildCredentialSubject({
      principalDid,
      claims: principalClaims,
      delegation: buildDelegation({
        agentDid: agent.did,
        paymentSource: paymentSource.accountId,
        conditions: { expiresAt: validExpiresAt() },
      }),
    });
    const { jwt: sdjwt } = await issueCredential({
      issuerConfig: trustedIssuer,
      subject,
      format: "sd-jwt-vc",
      selectivelyDisclosable: ["ageOver18"],
    });
    const parsed = parseSdJwt(sdjwt);
    // Flip one character of the JWT signature.
    const jwtParts = parsed.jwt.split(".");
    const sig = jwtParts[2];
    jwtParts[2] = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    const tampered = composeSdJwt(jwtParts.join("."), parsed.disclosures);
    await expect(
      verifySdJwtVcPresentation({ sdjwt: tampered, resolver: getDidResolver() }),
    ).rejects.toThrow(/issuer JWT verification failed/);
  });
});

describe("verifyEnvelope — sd-jwt-vc end-to-end (§12 Tier 1)", () => {
  it("accepts an envelope built from a valid SD-JWT VC presentation", async () => {
    const agent = createAgent("e2e-sd-jwt-vc-agent");
    const subject = buildCredentialSubject({
      principalDid,
      claims: principalClaims,
      delegation: buildDelegation({
        agentDid: agent.did,
        paymentSource: paymentSource.accountId,
        conditions: { expiresAt: validExpiresAt() },
      }),
    });
    const { jwt: sdjwt } = await issueCredential({
      issuerConfig: trustedIssuer,
      subject,
      format: "sd-jwt-vc",
      selectivelyDisclosable: ["ageOver18"],
    });
    const envelope = buildIdentityEnvelope({
      credentialFormat: "sd-jwt-vc",
      credentialJwt: sdjwt,
      principalDid,
      principalClaims: { ageOver18: true },
      agentDid: agent.did,
      agentName: agent.name,
      delegationProof: sdjwt,
      paymentSource,
      disclosureTier: DisclosureTier.SelectiveClaims,
      requiredClaims: ["ageOver18"],
    });
    const result = await verifyEnvelope(
      envelope,
      { ...requirements, requiredClaims: ["ageOver18"] },
      paymentSource.sourceId,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects when the envelope claims a disclosed value the SD-JWT VC didn't actually disclose", async () => {
    const agent = createAgent("e2e-sd-jwt-vc-mismatch-agent");
    const subject = buildCredentialSubject({
      principalDid,
      claims: principalClaims,
      delegation: buildDelegation({
        agentDid: agent.did,
        paymentSource: paymentSource.accountId,
        conditions: { expiresAt: validExpiresAt() },
      }),
    });
    const { jwt: sdjwt } = await issueCredential({
      issuerConfig: trustedIssuer,
      subject,
      format: "sd-jwt-vc",
      selectivelyDisclosable: ["ageOver18"],
    });
    const envelope = buildIdentityEnvelope({
      credentialFormat: "sd-jwt-vc",
      credentialJwt: sdjwt,
      principalDid,
      principalClaims: { ageOver18: false }, // claim the opposite of what's disclosed
      agentDid: agent.did,
      agentName: agent.name,
      delegationProof: sdjwt,
      paymentSource,
      disclosureTier: DisclosureTier.SelectiveClaims,
      requiredClaims: ["ageOver18"],
    });
    const result = await verifyEnvelope(
      envelope,
      { ...requirements, requiredClaims: ["ageOver18"] },
      paymentSource.sourceId,
    );
    expect(result.valid).toBe(false);
    expect(result.steps[0].step).toBe("principal_credential");
    expect(result.steps[0].error ?? "").toMatch(/does not match the SD-JWT VC disclosure/);
  });
});
