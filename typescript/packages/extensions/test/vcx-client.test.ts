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
  createVCXClientExtension,
  declareVCXExtension,
  VCX_EXTENSION_KEY,
  VCX_HEADER_NAME,
  parseVCXHeader,
  createAgent,
  buildCredentialSubject,
  buildDelegation,
  issueCredential,
  DisclosureTier,
} from "../src/vcx";
import { trustedIssuer, principalDid, principalClaims, paymentSource } from "./vcx-test-utils";

/**
 * Issues a credential and builds a VCX client extension wired to a fresh agent,
 * delegation, and the shared test payment source.
 *
 * @returns The configured client extension, the agent, and the issued credential JWT.
 */
async function buildClientWithCredential() {
  const agent = createAgent("client-test-agent");
  const delegation = buildDelegation({
    agentDid: agent.did,
    paymentSource: paymentSource.accountId,
    conditions: {
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  });
  const subject = buildCredentialSubject({
    principalDid,
    claims: principalClaims,
    delegation,
  });
  const { jwt } = await issueCredential({
    issuerConfig: trustedIssuer,
    subject,
  });
  const ext = createVCXClientExtension({
    principalCredential: jwt,
    principalDid,
    principalClaims,
    agent,
    paymentSource,
  });
  return { ext, agent, jwt };
}

const declarationFor = (opts = {}) =>
  declareVCXExtension({
    disclosureTier: DisclosureTier.SelectiveClaims,
    requiredClaims: ["kycLevel", "ageOver18"],
    minKycLevel: "IdentityVerified",
    acceptedIssuers: [trustedIssuer.did],
    ...opts,
  });

describe("createVCXClientExtension", () => {
  it("returns an extension registered under the VCX key", async () => {
    const { ext } = await buildClientWithCredential();
    expect(ext.key).toBe(VCX_EXTENSION_KEY);
    expect(ext.transportHooks?.http).toBeDefined();
  });

  describe("onPaymentRequired", () => {
    it("returns void when the 402 has no VCX extension declared", async () => {
      const { ext } = await buildClientWithCredential();
      const result = await ext.transportHooks!.http!.onPaymentRequired!(undefined, {
        paymentRequired: { extensions: {} },
      });
      expect(result).toBeUndefined();
    });

    it("returns a VCX header when the extension is declared", async () => {
      const { ext } = await buildClientWithCredential();
      const declared = declarationFor();
      const result = (await ext.transportHooks!.http!.onPaymentRequired!(undefined, {
        paymentRequired: { extensions: declared },
      })) as { headers: Record<string, string> } | undefined;

      expect(result?.headers[VCX_HEADER_NAME]).toBeTypeOf("string");
    });

    it("constructs an envelope matching the declared requirements", async () => {
      const { ext, agent } = await buildClientWithCredential();
      const declared = declarationFor();
      const result = (await ext.transportHooks!.http!.onPaymentRequired!(undefined, {
        paymentRequired: { extensions: declared },
      })) as { headers: Record<string, string> };

      const envelope = parseVCXHeader(result.headers[VCX_HEADER_NAME]);
      expect(envelope.version).toBe("1.0");
      expect(envelope.protocol).toBe("x402-vcx-v1");
      expect(envelope.principal.did).toBe(principalDid);
      expect(envelope.agent.did).toBe(agent.did);
      expect(envelope.paymentSource).toEqual(paymentSource);
      expect(envelope.principal.disclosed).toEqual({
        kycLevel: "IdentityVerified",
        ageOver18: true,
      });
    });

    it("uses delegationProof override when provided, defaulting to principalCredential otherwise", async () => {
      const { jwt, agent } = await buildClientWithCredential();
      const overrideExt = createVCXClientExtension({
        principalCredential: jwt,
        principalDid,
        principalClaims,
        agent,
        paymentSource,
        delegationProof: "explicit.override.proof",
      });

      const declared = declarationFor();
      const result = (await overrideExt.transportHooks!.http!.onPaymentRequired!(undefined, {
        paymentRequired: { extensions: declared },
      })) as { headers: Record<string, string> };

      const envelope = parseVCXHeader(result.headers[VCX_HEADER_NAME]);
      expect(envelope.agent.delegationProof).toBe("explicit.override.proof");
    });

    it("produces a unique transactionId per invocation", async () => {
      const { ext } = await buildClientWithCredential();
      const declared = declarationFor();
      const first = (await ext.transportHooks!.http!.onPaymentRequired!(undefined, {
        paymentRequired: { extensions: declared },
      })) as { headers: Record<string, string> };
      const second = (await ext.transportHooks!.http!.onPaymentRequired!(undefined, {
        paymentRequired: { extensions: declared },
      })) as { headers: Record<string, string> };

      const e1 = parseVCXHeader(first.headers[VCX_HEADER_NAME]);
      const e2 = parseVCXHeader(second.headers[VCX_HEADER_NAME]);
      expect(e1.transactionId).not.toBe(e2.transactionId);
    });
  });
});
