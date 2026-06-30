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
// End-to-end flow: client extension produces VCX header → server extension
// verifies it. Mirrors what the x402 v2 runtime will do in production.

import { describe, it, expect } from "vitest";
import {
  createVCXClientExtension,
  createVCXResourceServerExtension,
  declareVCXExtension,
  VCX_EXTENSION_KEY,
  VCX_HEADER_NAME,
  parseVCXHeader,
  InMemoryNonceStorage,
  createAgent,
  buildCredentialSubject,
  buildDelegation,
  issueCredential,
  DisclosureTier,
  type VCXRequestContext,
} from "../src/vcx";
import { trustedIssuer, principalDid, principalClaims, paymentSource } from "./vcx-test-utils";

/**
 * Issues a credential and returns a VCX client extension for the end-to-end flow.
 *
 * @returns The configured VCX client extension.
 */
async function setupClient() {
  const agent = createAgent("e2e-agent");
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
  return createVCXClientExtension({
    principalCredential: jwt,
    principalDid,
    principalClaims,
    agent,
    paymentSource,
  });
}

const declared = declareVCXExtension({
  disclosureTier: DisclosureTier.SelectiveClaims,
  requiredClaims: ["kycLevel", "ageOver18"],
  minKycLevel: "IdentityVerified",
  acceptedIssuers: [trustedIssuer.did],
});

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
 * Builds a server request context whose adapter exposes the given VCX header and
 * a base64 X-PAYMENT header carrying the supplied sender address.
 *
 * @param vcxHeader - The VCX header value to return for the `vcx` header lookup.
 * @param sender - The payment sender address to embed in the X-PAYMENT header.
 * @returns A context object with an `adapter.getHeader` lookup.
 */
function buildServerContext(vcxHeader: string, sender: string) {
  const paymentHeader = Buffer.from(
    JSON.stringify({ payload: { authorization: { from: sender } } }),
  ).toString("base64");
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

describe("VCX end-to-end via extension factories", () => {
  it("client produces a header that the server accepts", async () => {
    const clientExt = await setupClient();
    const serverExt = createVCXResourceServerExtension({
      extractPaymentSender: extractFromPayment,
      nonceStorage: new InMemoryNonceStorage(),
    });

    const clientResult = (await clientExt.transportHooks!.http!.onPaymentRequired!(undefined, {
      paymentRequired: { extensions: declared },
    })) as { headers: Record<string, string> };

    const headerValue = clientResult.headers[VCX_HEADER_NAME];
    expect(headerValue).toBeTypeOf("string");

    const result = await serverExt.transportHooks!.http!.onProtectedRequest!(
      declared[VCX_EXTENSION_KEY],
      buildServerContext(headerValue, paymentSource.sourceId),
      {},
    );
    expect(result).toBeUndefined();
  });

  it("server aborts on a tampered envelope at principal_credential", async () => {
    const clientExt = await setupClient();
    const serverExt = createVCXResourceServerExtension({
      extractPaymentSender: extractFromPayment,
      nonceStorage: new InMemoryNonceStorage(),
    });

    const clientResult = (await clientExt.transportHooks!.http!.onPaymentRequired!(undefined, {
      paymentRequired: { extensions: declared },
    })) as { headers: Record<string, string> };

    const envelope = parseVCXHeader(clientResult.headers[VCX_HEADER_NAME]);
    envelope.principal.disclosed.ageOver18 = false;
    const tamperedHeader = Buffer.from(JSON.stringify(envelope)).toString("base64");

    const result = await serverExt.transportHooks!.http!.onProtectedRequest!(
      declared[VCX_EXTENSION_KEY],
      buildServerContext(tamperedHeader, paymentSource.sourceId),
      {},
    );
    expect(result).toEqual({
      abort: true,
      reason: expect.stringMatching(/principal_credential/),
    });
  });
});
