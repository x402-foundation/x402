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
  generateEd25519KeyPair,
  publicKeyToDidKey,
  buildDid,
  createAgent,
  buildDelegation,
  buildCredentialSubject,
  meetsKycRequirement,
} from "../src/vcx";

describe("generateEd25519KeyPair", () => {
  it("produces 32-byte Ed25519 keys and a valid did:key", () => {
    const kp = generateEd25519KeyPair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
    expect(kp.did).toMatch(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/);
    expect(kp.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different keypair on each call", () => {
    const a = generateEd25519KeyPair();
    const b = generateEd25519KeyPair();
    expect(a.did).not.toBe(b.did);
    expect(a.privateKeyHex).not.toBe(b.privateKeyHex);
  });
});

describe("publicKeyToDidKey", () => {
  it("is deterministic for a given public key", () => {
    const kp = generateEd25519KeyPair();
    expect(publicKeyToDidKey(kp.publicKey)).toBe(kp.did);
    expect(publicKeyToDidKey(kp.publicKey)).toBe(publicKeyToDidKey(kp.publicKey));
  });

  it("produces distinct DIDs for distinct keys", () => {
    const a = generateEd25519KeyPair();
    const b = generateEd25519KeyPair();
    expect(publicKeyToDidKey(a.publicKey)).not.toBe(publicKeyToDidKey(b.publicKey));
  });
});

describe("buildDid", () => {
  it("formats a did:web identifier from domain and path", () => {
    expect(buildDid("example.com", "user/abc")).toBe("did:web:example.com:user/abc");
  });
});

describe("createAgent", () => {
  it("creates an agent with a did:key and preserves the provided name", () => {
    const agent = createAgent("payment-bot");
    expect(agent.name).toBe("payment-bot");
    expect(agent.did).toMatch(/^did:key:z/);
    expect(agent.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(agent.keyPair.did).toBe(agent.did);
  });

  it("creates a unique agent per call (independent keys)", () => {
    const a = createAgent("x");
    const b = createAgent("x");
    expect(a.did).not.toBe(b.did);
  });
});

describe("buildDelegation", () => {
  it("passes through agentDid, paymentSource, and conditions", () => {
    const d = buildDelegation({
      agentDid: "did:key:zAgent",
      paymentSource: "eip155:1:0xabc",
      conditions: {
        maxPerTransaction: "1000",
        allowedNetworks: ["eip155:1"],
        expiresAt: "2026-12-31T23:59:59Z",
      },
    });
    expect(d.agentDid).toBe("did:key:zAgent");
    expect(d.paymentSource).toBe("eip155:1:0xabc");
    expect(d.conditions?.maxPerTransaction).toBe("1000");
    expect(d.conditions?.allowedNetworks).toEqual(["eip155:1"]);
  });

  it("permits missing optional fields", () => {
    const d = buildDelegation({ agentDid: "did:key:zAgent" });
    expect(d.agentDid).toBe("did:key:zAgent");
    expect(d.paymentSource).toBeUndefined();
    expect(d.conditions).toBeUndefined();
  });
});

describe("buildCredentialSubject", () => {
  it("constructs a W3C VC subject from claims and delegation", () => {
    const subject = buildCredentialSubject({
      principalDid: "did:web:example.com:user/1",
      claims: { kycLevel: "IdentityVerified", ageOver18: true, emailVerified: true },
      delegation: { agentDid: "did:key:zAgent" },
    });
    expect(subject.id).toBe("did:web:example.com:user/1");
    expect(subject.kycLevel).toBe("IdentityVerified");
    expect(subject.ageOver18).toBe(true);
    expect(subject.emailVerified).toBe(true);
    expect(subject.delegatedTo.agentDid).toBe("did:key:zAgent");
  });

  it("defaults kycLevel to Unverified when not provided", () => {
    const subject = buildCredentialSubject({
      principalDid: "did:web:example.com:user/1",
      claims: {},
      delegation: { agentDid: "did:key:zAgent" },
    });
    expect(subject.kycLevel).toBe("Unverified");
  });
});

describe("meetsKycRequirement", () => {
  it("returns true when actual KYC meets or exceeds the required level", () => {
    expect(meetsKycRequirement("EmailVerified", "EmailVerified")).toBe(true);
    expect(meetsKycRequirement("IdentityVerified", "EmailVerified")).toBe(true);
    expect(meetsKycRequirement("BusinessVerified", "IdentityVerified")).toBe(true);
  });

  it("returns false when actual KYC is below the required level", () => {
    expect(meetsKycRequirement("Unverified", "EmailVerified")).toBe(false);
    expect(meetsKycRequirement("EmailVerified", "IdentityVerified")).toBe(false);
  });
});
