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
  createVCXResourceServerExtension,
  declareVCXExtension,
  VCX_EXTENSION_KEY,
  encodeVCXHeader,
  InMemoryNonceStorage,
  buildIdentityEnvelope,
  buildCredentialSubject,
  buildDelegation,
  createAgent,
  issueCredential,
  DisclosureTier,
  type VCXRequestContext,
} from "../src/vcx";
import {
  trustedIssuer,
  principalDid,
  principalClaims,
  paymentSource,
  requirements,
} from "./vcx-test-utils";

/**
 * Build a fully valid VCX identity envelope (agent, delegation, credential)
 * for use as the happy-path fixture in server extension tests.
 *
 * @returns A signed, verifiable VCX identity envelope.
 */
async function buildValidEnvelope() {
  const agent = createAgent("server-test-agent");
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
  return buildIdentityEnvelope({
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
}

/**
 * Encode a mock base64 X-PAYMENT header carrying the given payment sender address.
 *
 * @param sender - The payment sender address to embed in the authorization payload.
 * @returns A base64-encoded X-PAYMENT header value.
 */
function encodePaymentHeader(sender: string): string {
  return Buffer.from(JSON.stringify({ payload: { authorization: { from: sender } } })).toString(
    "base64",
  );
}

// Realistic extract function — mirrors the JSDoc example in src/server.ts.
const extractFromPayment = (ctx: VCXRequestContext): string => {
  const raw = ctx.getHeader("X-PAYMENT");
  if (!raw) return "";
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
      payload?: { authorization?: { from?: string } };
    };
    return parsed.payload?.authorization?.from ?? "";
  } catch {
    return "";
  }
};

/**
 * Build a mock request context whose adapter serves the given VCX and
 * X-PAYMENT headers, for driving the onProtectedRequest hook.
 *
 * @param vcxHeader - The VCX header value to serve, or undefined to omit it.
 * @param sender - The payment sender address encoded into the X-PAYMENT header.
 * @returns A mock request context with a header-resolving adapter.
 */
function makeContext(vcxHeader: string | undefined, sender: string = paymentSource.sourceId) {
  const paymentHeader = encodePaymentHeader(sender);
  return {
    adapter: {
      getHeader: (name: string): string | undefined => {
        const lower = name.toLowerCase();
        if (lower === "vcx") return vcxHeader;
        if (lower === "x-payment") return paymentHeader;
        return undefined;
      },
    },
  };
}

const declarationFor = (overrides: Partial<Parameters<typeof declareVCXExtension>[0]> = {}) =>
  declareVCXExtension({
    disclosureTier: DisclosureTier.SelectiveClaims,
    requiredClaims: ["kycLevel", "ageOver18"],
    minKycLevel: "IdentityVerified",
    acceptedIssuers: [trustedIssuer.did],
    ...overrides,
  })[VCX_EXTENSION_KEY];

const newServerExtension = (
  overrides: Partial<Parameters<typeof createVCXResourceServerExtension>[0]> = {},
) =>
  createVCXResourceServerExtension({
    extractPaymentSender: extractFromPayment,
    nonceStorage: new InMemoryNonceStorage(),
    ...overrides,
  });

describe("createVCXResourceServerExtension", () => {
  it("returns an extension registered under the VCX key", () => {
    const ext = newServerExtension();
    expect(ext.key).toBe(VCX_EXTENSION_KEY);
    expect(ext.transportHooks?.http).toBeDefined();
  });

  describe("enrichPaymentRequiredResponse", () => {
    it("returns the declaration's info and schema", async () => {
      const ext = newServerExtension();
      const decl = declarationFor();
      const enriched = (await ext.enrichPaymentRequiredResponse!(decl, {} as never)) as {
        info: unknown;
        schema: unknown;
      };
      expect(enriched.info).toEqual(decl.info);
      expect(enriched.schema).toEqual(decl.schema);
    });
  });

  describe("onProtectedRequest", () => {
    it("aborts when the VCX header is missing", async () => {
      const ext = newServerExtension();
      const result = await ext.transportHooks!.http!.onProtectedRequest!(
        declarationFor(),
        makeContext(undefined),
        {},
      );
      expect(result).toEqual({
        abort: true,
        reason: expect.stringMatching(/missing VCX header/i),
      });
    });

    it("aborts when the VCX header is malformed", async () => {
      const ext = newServerExtension();
      const result = await ext.transportHooks!.http!.onProtectedRequest!(
        declarationFor(),
        makeContext("not-base64-or-json-at-all"),
        {},
      );
      expect(result).toEqual({
        abort: true,
        reason: expect.stringMatching(/malformed envelope/i),
      });
    });

    it("aborts when verification fails (wrong payment sender)", async () => {
      const envelope = await buildValidEnvelope();
      const headerValue = encodeVCXHeader(envelope);
      const ext = newServerExtension();
      const result = await ext.transportHooks!.http!.onProtectedRequest!(
        declarationFor(),
        makeContext(headerValue, "0xWRONGSENDER"),
        {},
      );
      expect(result).toEqual({
        abort: true,
        reason: expect.stringMatching(/payment_source_binding/i),
      });
    });

    it("aborts on transactionId replay within the freshness window", async () => {
      const envelope = await buildValidEnvelope();
      const headerValue = encodeVCXHeader(envelope);
      const ext = newServerExtension();

      // First request succeeds and records the nonce.
      const first = await ext.transportHooks!.http!.onProtectedRequest!(
        declarationFor(),
        makeContext(headerValue),
        {},
      );
      expect(first).toBeUndefined();

      // Second identical request aborts as replay.
      const second = await ext.transportHooks!.http!.onProtectedRequest!(
        declarationFor(),
        makeContext(headerValue),
        {},
      );
      expect(second).toEqual({
        abort: true,
        reason: expect.stringMatching(/already processed within the freshness window/i),
      });
    });

    it("does NOT consume the nonce when verification fails (verify-then-record)", async () => {
      const envelope = await buildValidEnvelope();
      const headerValue = encodeVCXHeader(envelope);
      const ext = newServerExtension();

      // First request fails verification — nonce must remain unused.
      const failed = await ext.transportHooks!.http!.onProtectedRequest!(
        declarationFor(),
        makeContext(headerValue, "0xWRONGSENDER"),
        {},
      );
      expect(failed).toEqual({
        abort: true,
        reason: expect.stringMatching(/payment_source_binding/i),
      });

      // Second request with the same envelope but correct sender should succeed —
      // the failed attempt above did not poison the nonce cache.
      const success = await ext.transportHooks!.http!.onProtectedRequest!(
        declarationFor(),
        makeContext(headerValue),
        {},
      );
      expect(success).toBeUndefined();
    });

    it("aborts when extractPaymentSender throws", async () => {
      const ext = newServerExtension({
        extractPaymentSender: () => {
          throw new Error("scheme decoder unavailable");
        },
      });
      const envelope = await buildValidEnvelope();
      const headerValue = encodeVCXHeader(envelope);
      const result = await ext.transportHooks!.http!.onProtectedRequest!(
        declarationFor(),
        makeContext(headerValue),
        {},
      );
      expect(result).toEqual({
        abort: true,
        reason: expect.stringMatching(/extractor threw/i),
      });
    });

    it("succeeds and invokes onVerify when the envelope is valid", async () => {
      const envelope = await buildValidEnvelope();
      const headerValue = encodeVCXHeader(envelope);
      const onVerify = vi.fn();
      const ext = newServerExtension({ onVerify });
      const result = await ext.transportHooks!.http!.onProtectedRequest!(
        declarationFor(),
        makeContext(headerValue),
        {},
      );
      expect(result).toBeUndefined();
      expect(onVerify).toHaveBeenCalledTimes(1);
      const [verifiedEnvelope, verification] = onVerify.mock.calls[0];
      expect(verifiedEnvelope.transactionId).toBe(envelope.transactionId);
      expect(verification.valid).toBe(true);
    });

    it("invokes onVerify even when verification fails", async () => {
      const envelope = await buildValidEnvelope();
      const headerValue = encodeVCXHeader(envelope);
      const onVerify = vi.fn();
      const ext = newServerExtension({ onVerify });
      const result = await ext.transportHooks!.http!.onProtectedRequest!(
        declarationFor(),
        makeContext(headerValue, "0xWRONGSENDER"),
        {},
      );
      expect(result).toEqual({
        abort: true,
        reason: expect.stringMatching(/payment_source_binding/i),
      });
      expect(onVerify).toHaveBeenCalledTimes(1);
      expect(onVerify.mock.calls[0][1].valid).toBe(false);
    });
  });
});
