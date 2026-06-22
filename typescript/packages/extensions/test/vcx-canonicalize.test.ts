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

import { describe, it, expect } from "vitest";
import { canonicalEnvelope, envelopeDigest } from "../src/vcx";
import type { IdentityEnvelope } from "../src/vcx";

const baseEnvelope: IdentityEnvelope = {
  version: "1.0",
  protocol: "x402-vcx-v1",
  transactionId: "00000000-0000-4000-8000-000000000001",
  vcxPresent: true,
  principal: {
    credentialFormat: "jwt-vc",
    credentialJwt: "stub.jwt.value",
    did: "did:web:paypal.com:user/abc",
    disclosed: { kycLevel: "IdentityVerified", ageOver18: true },
  },
  agent: {
    did: "did:key:zAgent",
    name: "test-agent",
    delegationProofFormat: "vc-embedded",
    delegationProof: "stub.jwt.value",
  },
  paymentSource: {
    accountId: "eip155:8453:0xA11CE",
    sourceId: "0xA11CE",
    network: "eip155:8453",
  },
};

describe("envelopeDigest", () => {
  it("is byte-deterministic across different key insertion orders at every nesting level", () => {
    // Construct a logically-identical envelope by reversing property
    // insertion order at every nesting level. JCS MUST sort keys, so the
    // digest MUST be the same.
    //
    // Note: an earlier version of this test used
    // `JSON.stringify(env, Object.keys(env).reverse())` for the reorder,
    // but `JSON.stringify`'s array-replacer is an *allowlist* applied at
    // every level — top-level-only keys would filter out the nested
    // `principal`/`agent`/`paymentSource` fields entirely, masking the
    // property the test is supposed to exercise.
    const reordered: IdentityEnvelope = {
      paymentSource: {
        network: baseEnvelope.paymentSource.network,
        sourceId: baseEnvelope.paymentSource.sourceId,
        accountId: baseEnvelope.paymentSource.accountId,
      },
      agent: {
        delegationProof: baseEnvelope.agent.delegationProof,
        delegationProofFormat: baseEnvelope.agent.delegationProofFormat,
        name: baseEnvelope.agent.name,
        did: baseEnvelope.agent.did,
      },
      principal: {
        disclosed: {
          ageOver18: baseEnvelope.principal.disclosed.ageOver18,
          kycLevel: baseEnvelope.principal.disclosed.kycLevel,
        },
        did: baseEnvelope.principal.did,
        credentialJwt: baseEnvelope.principal.credentialJwt,
        credentialFormat: baseEnvelope.principal.credentialFormat,
      },
      vcxPresent: true,
      transactionId: baseEnvelope.transactionId,
      protocol: baseEnvelope.protocol,
      version: baseEnvelope.version,
    };
    expect(envelopeDigest(baseEnvelope)).toBe(envelopeDigest(reordered));
  });

  it("returns sha256:hex format with 64-char hex body", () => {
    const digest = envelopeDigest(baseEnvelope);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when any envelope field changes (avalanche check)", () => {
    const original = envelopeDigest(baseEnvelope);
    const mutated = envelopeDigest({
      ...baseEnvelope,
      transactionId: "00000000-0000-4000-8000-000000000002",
    });
    expect(original).not.toBe(mutated);
  });

  it("changes when a nested principal claim changes", () => {
    const original = envelopeDigest(baseEnvelope);
    const mutated = envelopeDigest({
      ...baseEnvelope,
      principal: {
        ...baseEnvelope.principal,
        disclosed: { ...baseEnvelope.principal.disclosed, ageOver18: false },
      },
    });
    expect(original).not.toBe(mutated);
  });
});

describe("canonicalEnvelope", () => {
  it("returns UTF-8 bytes that parse back to the input shape", () => {
    const bytes = canonicalEnvelope(baseEnvelope);
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json) as IdentityEnvelope;
    expect(parsed.transactionId).toBe(baseEnvelope.transactionId);
    expect(parsed.principal.credentialFormat).toBe("jwt-vc");
    expect(parsed.vcxPresent).toBe(true);
  });

  it("emits keys in sorted order (JCS requirement)", () => {
    const bytes = canonicalEnvelope(baseEnvelope);
    const json = new TextDecoder().decode(bytes);
    // Top-level keys MUST appear sorted: agent, paymentSource, principal,
    // protocol, transactionId, vcxPresent, version.
    const topLevelKeyOrder = json.match(
      /"(agent|paymentSource|principal|protocol|transactionId|vcxPresent|version)"\s*:/g,
    );
    expect(topLevelKeyOrder).toEqual([
      '"agent":',
      '"paymentSource":',
      '"principal":',
      '"protocol":',
      '"transactionId":',
      '"vcxPresent":',
      '"version":',
    ]);
  });
});
