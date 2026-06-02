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

import { describe, it, expect, vi } from "vitest";
import {
  buildIdentityEnvelope,
  buildEnvelopeFromRequirements,
  verifyEnvelope,
  buildCredentialSubject,
  buildDelegation,
  createAgent,
  issueCredential,
  DisclosureTier,
} from "../src/vcx";
import {
  trustedIssuer,
  principalDid,
  principalClaims,
  paymentSource,
  requirements,
  newIssuer,
} from "./vcx-test-utils";

describe("buildIdentityEnvelope", () => {
  const baseOpts = {
    credentialJwt: "stub.jwt.value",
    principalDid,
    principalClaims,
    agentDid: "did:key:zAgent",
    agentName: "test-agent",
    delegationProof: "stub.jwt.value",
    paymentSource,
  };

  it("constructs a 3-layer envelope with required protocol metadata", () => {
    const env = buildIdentityEnvelope({
      ...baseOpts,
      disclosureTier: DisclosureTier.SelectiveClaims,
      requiredClaims: ["kycLevel"],
    });
    expect(env.version).toBe("1.0");
    expect(env.protocol).toBe("x402-vcx-v1");
    expect(env.transactionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.vcxPresent).toBe(true);
    expect(env.principal.did).toBe(principalDid);
    expect(env.principal.credentialJwt).toBe("stub.jwt.value");
    expect(env.principal.credentialFormat).toBe("jwt-vc");
    expect(env.principal.disclosed).toEqual({ kycLevel: "IdentityVerified" });
    expect(env.agent).toEqual({
      did: "did:key:zAgent",
      name: "test-agent",
      delegationProofFormat: "vc-embedded",
      delegationProof: "stub.jwt.value",
    });
    expect(env.paymentSource).toEqual(paymentSource);
  });

  it("propagates a non-default credentialFormat", () => {
    const env = buildIdentityEnvelope({
      ...baseOpts,
      credentialFormat: "sd-jwt-vc",
    });
    expect(env.principal.credentialFormat).toBe("sd-jwt-vc");
  });

  it("discloses nothing at IssuerOnly tier", () => {
    const env = buildIdentityEnvelope({
      ...baseOpts,
      disclosureTier: DisclosureTier.IssuerOnly,
    });
    expect(env.principal.disclosed).toEqual({});
  });

  it("discloses all claims at FullDisclosure tier", () => {
    const env = buildIdentityEnvelope({
      ...baseOpts,
      disclosureTier: DisclosureTier.FullDisclosure,
    });
    expect(env.principal.disclosed).toEqual(principalClaims);
  });

  it("discloses only requiredClaims at SelectiveClaims tier", () => {
    const env = buildIdentityEnvelope({
      ...baseOpts,
      disclosureTier: DisclosureTier.SelectiveClaims,
      requiredClaims: ["kycLevel", "ageOver18"],
    });
    expect(env.principal.disclosed).toEqual({
      kycLevel: "IdentityVerified",
      ageOver18: true,
    });
  });

  it("produces a unique transactionId per call", () => {
    const a = buildIdentityEnvelope(baseOpts);
    const b = buildIdentityEnvelope(baseOpts);
    expect(a.transactionId).not.toBe(b.transactionId);
  });
});

describe("buildEnvelopeFromRequirements", () => {
  it("applies disclosureTier and requiredClaims from the requirements object", () => {
    const env = buildEnvelopeFromRequirements(
      {
        credentialJwt: "x",
        principalDid,
        principalClaims,
        agentDid: "did:key:zAgent",
        agentName: "a",
        delegationProof: "x",
        paymentSource,
      },
      requirements
    );
    expect(env.principal.disclosed).toEqual({
      kycLevel: "IdentityVerified",
      ageOver18: true,
    });
  });
});

async function buildValidScenario(overrides?: {
  conditions?: Record<string, unknown>;
  paymentSourceOverride?: typeof paymentSource;
}) {
  const agent = createAgent("verify-agent");
  const conditions = (overrides?.conditions ?? {
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }) as Record<string, unknown>;
  const delegation = buildDelegation({
    agentDid: agent.did,
    paymentSource: (overrides?.paymentSourceOverride ?? paymentSource).accountId,
    // Cast to bypass DelegationConditions strict typing for tests that need
    // to inject unknown keys to exercise the §13.4 fail-closed path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conditions: conditions as any,
  });
  const subject = buildCredentialSubject({ principalDid, claims: principalClaims, delegation });
  const { jwt } = await issueCredential({ issuerConfig: trustedIssuer, subject });
  const envelope = buildIdentityEnvelope({
    credentialJwt: jwt,
    principalDid,
    principalClaims,
    agentDid: agent.did,
    agentName: agent.name,
    delegationProof: jwt,
    paymentSource: overrides?.paymentSourceOverride ?? paymentSource,
    disclosureTier: DisclosureTier.SelectiveClaims,
    requiredClaims: requirements.requiredClaims,
  });
  return { envelope, agent, jwt };
}

describe("verifyEnvelope", () => {
  it("passes for a valid envelope from a trusted issuer", async () => {
    const { envelope } = await buildValidScenario();
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(true);
    expect(result.steps).toHaveLength(4);
    expect(result.steps.map((s) => s.step)).toEqual([
      "principal_credential",
      "agent_delegation",
      "payment_source_binding",
      "payment_settlement",
    ]);
    expect(result.steps.every((s) => s.success)).toBe(true);
  });

  it("rejects a forged credential signature", async () => {
    const { envelope } = await buildValidScenario();
    const parts = envelope.principal.credentialJwt.split(".");
    const sig = parts[2];
    parts[2] = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    envelope.principal.credentialJwt = parts.join(".");
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    expect(result.steps[0].step).toBe("principal_credential");
    expect(result.steps[0].success).toBe(false);
  });

  it("rejects when issuer is not in acceptedIssuers", async () => {
    const untrusted = newIssuer();
    const agent = createAgent("untrusted-issuer-agent");
    const delegation = buildDelegation({
      agentDid: agent.did,
      paymentSource: paymentSource.accountId,
      conditions: { expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    });
    const subject = buildCredentialSubject({ principalDid, claims: principalClaims, delegation });
    const { jwt } = await issueCredential({ issuerConfig: untrusted, subject });
    const envelope = buildIdentityEnvelope({
      credentialJwt: jwt,
      principalDid,
      principalClaims,
      agentDid: agent.did,
      agentName: agent.name,
      delegationProof: jwt,
      paymentSource,
      disclosureTier: DisclosureTier.SelectiveClaims,
      requiredClaims: requirements.requiredClaims,
    });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    expect(result.steps[0].step).toBe("principal_credential");
    expect(result.steps[0].error ?? "").toMatch(/not in resolved trust list/);
  });

  it("rejects when envelope.agent.did does not match credential.delegatedTo.agentDid", async () => {
    const { envelope } = await buildValidScenario();
    envelope.agent.did = "did:key:zMismatchedAgent";
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.success).toBe(false);
  });

  it("rejects when payment sender does not match payment source", async () => {
    const { envelope } = await buildValidScenario();
    const result = await verifyEnvelope(envelope, requirements, "0xWRONGSENDER");
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "payment_source_binding");
    expect(step?.success).toBe(false);
    // Verifier short-circuits on first failure; settlement step MUST NOT appear.
    expect(
      result.steps.find((s) => s.step === "payment_settlement"),
    ).toBeUndefined();
  });

  it("rejects an expired delegation", async () => {
    const agent = createAgent("expired-agent");
    const delegation = buildDelegation({
      agentDid: agent.did,
      paymentSource: paymentSource.accountId,
      conditions: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    const subject = buildCredentialSubject({ principalDid, claims: principalClaims, delegation });
    const { jwt } = await issueCredential({ issuerConfig: trustedIssuer, subject });
    const envelope = buildIdentityEnvelope({
      credentialJwt: jwt,
      principalDid,
      principalClaims,
      agentDid: agent.did,
      agentName: agent.name,
      delegationProof: jwt,
      paymentSource,
      disclosureTier: DisclosureTier.SelectiveClaims,
      requiredClaims: requirements.requiredClaims,
    });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.success).toBe(false);
    expect(step?.error ?? "").toMatch(/expired/i);
  });

  it("rejects when a disclosed claim does not match the credential", async () => {
    const { envelope } = await buildValidScenario();
    envelope.principal.disclosed.ageOver18 = false;
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    expect(result.steps[0].step).toBe("principal_credential");
    expect(result.steps[0].error ?? "").toMatch(/match credential|disclosed/i);
  });

  // Regression: B1 from the v0.1 prep security review. Attack scenario:
  // delegation authorises payments from accountId X; attacker constructs an
  // envelope that keeps accountId=X (passes Step 2) but uses a different
  // sourceId Y, then pays from Y (passes Step 3's first sub-check). Without
  // the accountId↔sourceId binding, the verifier accepts; with it, rejects.
  it("rejects when sourceId does not match the accountId address component (B1 binding)", async () => {
    const { envelope } = await buildValidScenario();
    envelope.paymentSource.sourceId =
      "0xATTACKER000000000000000000000000000FACE";
    const result = await verifyEnvelope(
      envelope,
      requirements,
      "0xATTACKER000000000000000000000000000FACE",
    );
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "payment_source_binding");
    expect(step?.success).toBe(false);
    expect(step?.error ?? "").toMatch(/address component/i);
  });

  it("rejects when envelope vcxPresent is missing", async () => {
    const { envelope } = await buildValidScenario();
    delete (envelope as { vcxPresent?: unknown }).vcxPresent;
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    expect(result.steps[0].step).toBe("principal_credential");
    expect(result.steps[0].error ?? "").toMatch(/vcxPresent/);
  });

  it("rejects when envelope vcxPresent is not the literal true", async () => {
    const { envelope } = await buildValidScenario();
    (envelope as { vcxPresent: unknown }).vcxPresent = "true";
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    expect(result.steps[0].error ?? "").toMatch(/vcxPresent/);
  });

  it("rejects when principal.credentialFormat is missing", async () => {
    const { envelope } = await buildValidScenario();
    delete (envelope.principal as { credentialFormat?: unknown }).credentialFormat;
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    expect(result.steps[0].step).toBe("principal_credential");
    expect(result.steps[0].error ?? "").toMatch(/credentialFormat/);
  });

  it("rejects when principal.credentialFormat is out of enum", async () => {
    const { envelope } = await buildValidScenario();
    (envelope.principal as { credentialFormat: unknown }).credentialFormat =
      "ld-vc";
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    expect(result.steps[0].error ?? "").toMatch(/credentialFormat/);
  });

  it("rejects credentialFormat=sd-jwt-vc with a deferred-to-v1.0.0 message in v0.2.0", async () => {
    const { envelope } = await buildValidScenario();
    envelope.principal.credentialFormat = "sd-jwt-vc";
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    expect(result.steps[0].error ?? "").toMatch(/SD-JWT VC.*v1\.0\.0/i);
  });

  it("rejects when agent.delegationProofFormat is missing", async () => {
    const { envelope } = await buildValidScenario();
    delete (envelope.agent as { delegationProofFormat?: unknown })
      .delegationProofFormat;
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.success).toBe(false);
    expect(step?.error ?? "").toMatch(/delegationProofFormat/);
  });

  it("rejects when agent.delegationProofFormat is a reserved-but-non-v1 value", async () => {
    const { envelope } = await buildValidScenario();
    (envelope.agent as { delegationProofFormat: unknown }).delegationProofFormat =
      "ucan";
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.error ?? "").toMatch(/delegationProofFormat/);
  });

  // Regression: B2 from the v0.1 prep security review. When minKycLevel is
  // set, a credential whose subject omits kycLevel MUST be rejected
  // (fail-closed), not silently allowed.
  it("rejects when minKycLevel is set but credential lacks kycLevel (B2 fail-closed)", async () => {
    const agent = createAgent("b2-fail-closed-agent");
    // Bypass buildCredentialSubject (which would default kycLevel to "Unverified")
    // to simulate an issuer that omits the field entirely.
    const customSubject = {
      id: principalDid,
      delegatedTo: {
        agentDid: agent.did,
        paymentSource: paymentSource.accountId,
        conditions: {
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      },
      // kycLevel intentionally omitted
    };
    const { jwt } = await issueCredential({
      issuerConfig: trustedIssuer,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subject: customSubject as any,
    });
    const envelope = buildIdentityEnvelope({
      credentialJwt: jwt,
      principalDid,
      principalClaims: {},
      agentDid: agent.did,
      agentName: agent.name,
      delegationProof: jwt,
      paymentSource,
      disclosureTier: DisclosureTier.IssuerOnly,
    });
    const result = await verifyEnvelope(
      envelope,
      {
        protocol: "x402-vcx-v1",
        disclosureTier: DisclosureTier.IssuerOnly,
        minKycLevel: "IdentityVerified",
        acceptedIssuers: [trustedIssuer.did],
      },
      paymentSource.sourceId,
    );
    expect(result.valid).toBe(false);
    expect(result.steps[0].step).toBe("principal_credential");
    expect(result.steps[0].error ?? "").toMatch(/kycLevel/i);
  });
});

// v0.3 §9.2 full delegation enforcement: every condition's happy path and
// every failure path. Reads against verifier.ts:verifyAgentDelegation.
describe("verifyEnvelope — v0.3 §9.2 delegation conditions", () => {
  const validExpiresAt = () =>
    new Date(Date.now() + 60 * 60 * 1000).toISOString();

  it("rejects an unknown condition key (§13.4 fail-closed)", async () => {
    const { envelope } = await buildValidScenario({
      conditions: { expiresAt: validExpiresAt(), geoFence: "EU" },
    });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.error ?? "").toMatch(/geoFence|Unknown delegation condition/);
  });

  it("rejects a delegation with no conditions block", async () => {
    const { envelope } = await buildValidScenario({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conditions: undefined as any,
    });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.error ?? "").toMatch(/conditions/i);
  });

  it("rejects when expiresAt is missing from conditions", async () => {
    const { envelope } = await buildValidScenario({
      conditions: { maxPerTransaction: "1000" },
    });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId, {
      paymentAmount: "500",
    });
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.error ?? "").toMatch(/expiresAt/);
  });

  it("rejects expiresAt beyond the 30-day cap from credential nbf", async () => {
    const { envelope } = await buildValidScenario({
      conditions: {
        expiresAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.error ?? "").toMatch(/30-day/);
  });

  it("rejects when maxPerTransaction is set but paymentAmount was not supplied", async () => {
    const { envelope } = await buildValidScenario({
      conditions: { expiresAt: validExpiresAt(), maxPerTransaction: "1000" },
    });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.error ?? "").toMatch(/maxPerTransaction.*paymentAmount/i);
  });

  it("rejects when payment amount exceeds maxPerTransaction", async () => {
    const { envelope } = await buildValidScenario({
      conditions: { expiresAt: validExpiresAt(), maxPerTransaction: "1000" },
    });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId, {
      paymentAmount: "1500",
    });
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.error ?? "").toMatch(/exceeds delegation maxPerTransaction/);
  });

  it("accepts when payment amount equals maxPerTransaction (BigInt boundary)", async () => {
    const { envelope } = await buildValidScenario({
      conditions: { expiresAt: validExpiresAt(), maxPerTransaction: "1000" },
    });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId, {
      paymentAmount: "1000",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects when paymentSource.network is not in allowedNetworks", async () => {
    const { envelope } = await buildValidScenario({
      conditions: {
        expiresAt: validExpiresAt(),
        allowedNetworks: ["eip155:1"], // mainnet, but envelope is on Base (8453)
      },
    });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.error ?? "").toMatch(/allowedNetworks/);
  });

  it("accepts when paymentSource.network is in allowedNetworks", async () => {
    const { envelope } = await buildValidScenario({
      conditions: {
        expiresAt: validExpiresAt(),
        allowedNetworks: ["eip155:1", paymentSource.network],
      },
    });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(true);
  });

  it("rejects when allowedAssets is set but envelope.paymentSource.asset is absent", async () => {
    const { envelope } = await buildValidScenario({
      conditions: {
        expiresAt: validExpiresAt(),
        allowedAssets: ["0xUSDC"],
      },
    });
    // paymentSource fixture has no `asset` field → reject
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.error ?? "").toMatch(/allowedAssets.*absent|asset is absent/);
  });

  it("rejects when paymentSource.asset is not in allowedAssets", async () => {
    const paymentSourceWithAsset = { ...paymentSource, asset: "0xWBTC" };
    const { envelope } = await buildValidScenario({
      conditions: {
        expiresAt: validExpiresAt(),
        allowedAssets: ["0xUSDC", "0xUSDT"],
      },
      paymentSourceOverride: paymentSourceWithAsset,
    });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.error ?? "").toMatch(/allowedAssets/);
  });

  it("accepts when paymentSource.asset is in allowedAssets", async () => {
    const paymentSourceWithAsset = { ...paymentSource, asset: "0xUSDC" };
    const { envelope } = await buildValidScenario({
      conditions: {
        expiresAt: validExpiresAt(),
        allowedAssets: ["0xUSDC", "0xUSDT"],
      },
      paymentSourceOverride: paymentSourceWithAsset,
    });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId);
    expect(result.valid).toBe(true);
  });

  it("rejects maxDaily with no store under strictDelegationConditions", async () => {
    const { envelope } = await buildValidScenario({
      conditions: { expiresAt: validExpiresAt(), maxDaily: "10000" },
    });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId, {
      paymentAmount: "500",
      strictDelegationConditions: true,
    });
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.error ?? "").toMatch(/maxDaily.*dailyLimitStore/);
  });

  it("warn-and-skips maxDaily with no store when not strict", async () => {
    const { envelope } = await buildValidScenario({
      conditions: { expiresAt: validExpiresAt(), maxDaily: "10000" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId, {
      paymentAmount: "500",
    });
    expect(result.valid).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("rejects when DailyLimitStore total exceeds maxDaily", async () => {
    const { envelope } = await buildValidScenario({
      conditions: { expiresAt: validExpiresAt(), maxDaily: "1000" },
    });
    const store = {
      addAndGetTotal: async () => "1500",
    };
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId, {
      paymentAmount: "500",
      dailyLimitStore: store,
    });
    expect(result.valid).toBe(false);
    const step = result.steps.find((s) => s.step === "agent_delegation");
    expect(step?.error ?? "").toMatch(/Daily total.*exceeds.*maxDaily/);
  });

  it("accepts when DailyLimitStore total is within maxDaily", async () => {
    const { envelope } = await buildValidScenario({
      conditions: { expiresAt: validExpiresAt(), maxDaily: "10000" },
    });
    const store = {
      addAndGetTotal: async () => "750",
    };
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId, {
      paymentAmount: "500",
      dailyLimitStore: store,
    });
    expect(result.valid).toBe(true);
  });
});
