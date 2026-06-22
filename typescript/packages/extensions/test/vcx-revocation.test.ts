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
  buildIdentityEnvelope,
  buildCredentialSubject,
  buildDelegation,
  createAgent,
  verifyEnvelope,
  InMemoryStatusListCache,
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
import {
  STATUS_LIST_URL,
  buildEncodedList,
  issueStatusListCredential,
  issueLongLivedCredential,
  issueShortLivedCredentialWithStatus,
  mockStatusListFetch,
} from "./vcx-test-utils";

const validExpiresAt = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

/**
 * Build a long-lived credential scenario: an identity envelope plus a matching
 * signed status list credential with the given revoked indices.
 *
 * @param opts - Options for the scenario.
 * @param opts.statusListIndex - The status list index assigned to the credential.
 * @param opts.revokedIndices - The indices marked revoked in the status list.
 * @returns The envelope, agent, credential JWT, and status list JWT.
 */
async function buildLongLivedScenario(opts: { statusListIndex: number; revokedIndices: number[] }) {
  const agent = createAgent("revocation-test-agent");
  const delegation = buildDelegation({
    agentDid: agent.did,
    paymentSource: paymentSource.accountId,
    conditions: { expiresAt: validExpiresAt() },
  });
  const subject = buildCredentialSubject({
    principalDid,
    claims: principalClaims,
    delegation,
  });
  const jwt = await issueLongLivedCredential({
    issuerConfig: trustedIssuer,
    subject,
    statusListIndex: opts.statusListIndex,
  });
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
  const statusListJwt = await issueStatusListCredential({
    issuerConfig: trustedIssuer,
    encodedList: buildEncodedList({ revokedIndices: opts.revokedIndices }),
  });
  return { envelope, agent, jwt, statusListJwt };
}

describe("checkCredentialStatus — short-lived profile (§11.1)", () => {
  it("rejects a short-lived credential that carries a credentialStatus field", async () => {
    const agent = createAgent("short-lived-with-status-agent");
    const delegation = buildDelegation({
      agentDid: agent.did,
      paymentSource: paymentSource.accountId,
      conditions: { expiresAt: validExpiresAt() },
    });
    const subject = buildCredentialSubject({
      principalDid,
      claims: principalClaims,
      delegation,
    });
    const jwt = await issueShortLivedCredentialWithStatus({
      issuerConfig: trustedIssuer,
      subject,
    });
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
    expect(result.steps[0].error ?? "").toMatch(/Short-lived.*credentialStatus/);
  });
});

describe("checkCredentialStatus — Bitstring Status List v1.0 (§11.2)", () => {
  it("accepts a long-lived credential whose status bit is 0", async () => {
    const { envelope, statusListJwt } = await buildLongLivedScenario({
      statusListIndex: 42,
      revokedIndices: [],
    });
    const fetchMock = mockStatusListFetch({ body: statusListJwt });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId, {
      fetchImpl: fetchMock,
    });
    expect(result.valid).toBe(true);
    expect(fetchMock.calls).toBe(1);
  });

  it("rejects a long-lived credential whose status bit is 1 (revoked)", async () => {
    const { envelope, statusListJwt } = await buildLongLivedScenario({
      statusListIndex: 42,
      revokedIndices: [42],
    });
    const fetchMock = mockStatusListFetch({ body: statusListJwt });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId, {
      fetchImpl: fetchMock,
    });
    expect(result.valid).toBe(false);
    expect(result.steps[0].error ?? "").toMatch(/revoked/);
  });

  it("rejects a long-lived credential with no credentialStatus field", async () => {
    const agent = createAgent("long-lived-no-status-agent");
    const delegation = buildDelegation({
      agentDid: agent.did,
      paymentSource: paymentSource.accountId,
      conditions: { expiresAt: validExpiresAt() },
    });
    const subject = buildCredentialSubject({
      principalDid,
      claims: principalClaims,
      delegation,
    });
    // Issue with 48h lifetime but no credentialStatus override → uses
    // the helper's default, which DOES set credentialStatus. To exercise
    // the missing-status path we must drop the override after the fact.
    // Easier: build the long-lived JWT then mutate. But did-jwt-vc would
    // re-sign. Cleanest: use issueShortLivedCredentialWithStatus's helper
    // pattern but with no status. Build it inline instead.
    const { createVerifiableCredentialJwt } = await import("did-jwt-vc");
    const { EdDSASigner } = await import("did-jwt");
    const issuer = {
      did: trustedIssuer.did,
      signer: EdDSASigner(Uint8Array.from(Buffer.from(trustedIssuer.privateKeyHex, "hex"))),
      alg: "EdDSA",
    };
    const now = Math.floor(Date.now() / 1000);
    const jwt = await createVerifiableCredentialJwt(
      {
        sub: subject.id,
        nbf: now,
        exp: now + 48 * 60 * 60,
        vc: {
          "@context": ["https://www.w3.org/2018/credentials/v1"],
          type: ["VerifiableCredential", "X402IdentityCredential"],
          credentialSubject: subject,
        },
      },
      issuer,
    );
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
    expect(result.steps[0].error ?? "").toMatch(/Long-lived.*credentialStatus/);
  });

  it("rejects a credentialStatus whose type is not BitstringStatusListEntry", async () => {
    const agent = createAgent("wrong-status-type-agent");
    const delegation = buildDelegation({
      agentDid: agent.did,
      paymentSource: paymentSource.accountId,
      conditions: { expiresAt: validExpiresAt() },
    });
    const subject = buildCredentialSubject({
      principalDid,
      claims: principalClaims,
      delegation,
    });
    const jwt = await issueLongLivedCredential({
      issuerConfig: trustedIssuer,
      subject,
      statusListIndex: 0,
      credentialStatusOverride: {
        id: `${STATUS_LIST_URL}#0`,
        type: "RevocationList2020Status", // legacy type, not accepted in v1
        statusListIndex: "0",
        statusListCredential: STATUS_LIST_URL,
      },
    });
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
    expect(result.steps[0].error ?? "").toMatch(/BitstringStatusListEntry/);
  });

  it("rejects a credentialStatus whose statusPurpose is not revocation", async () => {
    const agent = createAgent("wrong-purpose-agent");
    const delegation = buildDelegation({
      agentDid: agent.did,
      paymentSource: paymentSource.accountId,
      conditions: { expiresAt: validExpiresAt() },
    });
    const subject = buildCredentialSubject({
      principalDid,
      claims: principalClaims,
      delegation,
    });
    const jwt = await issueLongLivedCredential({
      issuerConfig: trustedIssuer,
      subject,
      statusListIndex: 0,
      credentialStatusOverride: {
        id: `${STATUS_LIST_URL}#0`,
        type: "BitstringStatusListEntry",
        statusPurpose: "suspension", // v1 supports revocation only
        statusListIndex: "0",
        statusListCredential: STATUS_LIST_URL,
      },
    });
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
    expect(result.steps[0].error ?? "").toMatch(/statusPurpose.*revocation/);
  });

  it("rejects a status list signed by a different issuer than the credential", async () => {
    const otherIssuer = newIssuer();
    const { envelope } = await buildLongLivedScenario({
      statusListIndex: 0,
      revokedIndices: [],
    });
    // Sign status list with a DIFFERENT issuer than the principal credential.
    const statusListJwt = await issueStatusListCredential({
      issuerConfig: otherIssuer,
      encodedList: buildEncodedList({ revokedIndices: [] }),
    });
    const fetchMock = mockStatusListFetch({ body: statusListJwt });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId, {
      fetchImpl: fetchMock,
    });
    expect(result.valid).toBe(false);
    expect(result.steps[0].error ?? "").toMatch(/status list issuer.*MUST equal/);
  });

  it("honours the cache: second verification of the same status list URL does not refetch", async () => {
    const { envelope, statusListJwt } = await buildLongLivedScenario({
      statusListIndex: 7,
      revokedIndices: [],
    });
    const cache = new InMemoryStatusListCache();
    const fetchMock = mockStatusListFetch({
      body: statusListJwt,
      cacheControl: "max-age=3600",
    });
    const first = await verifyEnvelope(envelope, requirements, paymentSource.sourceId, {
      fetchImpl: fetchMock,
      statusListCache: cache,
    });
    expect(first.valid).toBe(true);
    expect(fetchMock.calls).toBe(1);

    // Build a second envelope referencing the same status list at a
    // different index. Cache HIT should mean no second fetch.
    const second = await buildLongLivedScenario({
      statusListIndex: 8,
      revokedIndices: [],
    });
    const secondResult = await verifyEnvelope(
      second.envelope,
      requirements,
      paymentSource.sourceId,
      { fetchImpl: fetchMock, statusListCache: cache },
    );
    expect(secondResult.valid).toBe(true);
    expect(fetchMock.calls).toBe(1);
  });

  it("rejects when status list fetch returns non-2xx", async () => {
    const { envelope } = await buildLongLivedScenario({
      statusListIndex: 0,
      revokedIndices: [],
    });
    // mockStatusListFetch returns 404 for any URL that isn't STATUS_LIST_URL;
    // here we override by giving it the wrong base body — but the cleanest
    // way to test the error path is just an empty fetch impl that 500s.
    const failingFetch = async (): Promise<Response> =>
      new Response("server exploded", { status: 500 });
    const result = await verifyEnvelope(envelope, requirements, paymentSource.sourceId, {
      fetchImpl: failingFetch as typeof fetch,
    });
    expect(result.valid).toBe(false);
    expect(result.steps[0].error ?? "").toMatch(/HTTP 500|Failed to fetch/);
  });
});
