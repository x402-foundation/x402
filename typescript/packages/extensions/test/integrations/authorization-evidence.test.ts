/**
 * Integration tests for the Authorization Evidence Extension in the x402
 * payment flow: challenge minting on PaymentRequired, client echo with
 * evidence attachment, and the pre-verify gate over a real spawned verifier.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import {
  buildCashPaymentRequirements,
  CashFacilitatorClient,
  createCashX402Client,
  CashSchemeNetworkFacilitator,
  CashSchemeNetworkServer,
} from "../../../core/test/mocks";
import {
  AUTHORIZATION_EVIDENCE,
  AuthorizationEvidenceClientExtension,
  createAuthorizationEvidenceResourceServerExtension,
  createCommandVerifier,
  declareAuthorizationEvidenceExtension,
} from "../../src/authorization-evidence";

const AUDIENCE = "merchant@example.com";
const RESOURCE = {
  url: "https://example.com/api/report",
  description: "Paid report",
  mimeType: "application/json",
};

/**
 * Build a verifier command that prints one fixed verdict and exits 0.
 *
 * @param verdict - The verdict object the verifier writes
 * @returns argv for createCommandVerifier
 */
function scriptedVerifier(verdict: object): string[] {
  const stdout = JSON.stringify(verdict);
  return ["node", "-e", `process.stdout.write(${JSON.stringify(stdout)})`];
}

describe("Authorization Evidence Integration Tests", () => {
  let client: x402Client;
  let server: x402ResourceServer;

  /**
   * Wire a fresh server around a scripted verifier verdict.
   *
   * @param verdict - The verdict the spawned verifier returns
   * @returns The initialized resource server
   */
  async function buildServer(verdict: object): Promise<x402ResourceServer> {
    const facilitator = new x402Facilitator().register(
      "x402:cash",
      new CashSchemeNetworkFacilitator(),
    );
    const facilitatorClient = new CashFacilitatorClient(facilitator);
    const built = new x402ResourceServer(facilitatorClient);
    built.register("x402:cash", new CashSchemeNetworkServer());
    built.registerExtension(
      createAuthorizationEvidenceResourceServerExtension({
        audience: AUDIENCE,
        verifier: createCommandVerifier({ command: scriptedVerifier(verdict) }),
      }),
    );
    await built.initialize();
    return built;
  }

  beforeEach(async () => {
    client = createCashX402Client("payer").registerExtension(
      new AuthorizationEvidenceClientExtension(async () => "demo-mandate-presentation"),
    );
    server = await buildServer({ verdict: "allow" });
  });

  it("mints a signed challenge into PaymentRequired and validates the echo", async () => {
    const accepts = [buildCashPaymentRequirements(AUDIENCE, "USD", "1")];
    const declared = declareAuthorizationEvidenceExtension();
    const paymentRequired = await server.createPaymentRequiredResponse(
      accepts,
      RESOURCE,
      undefined,
      declared,
    );

    const advertised = (
      paymentRequired.extensions as Record<string, { info: Record<string, unknown> }>
    )[AUTHORIZATION_EVIDENCE].info;
    expect(advertised.nonce).toMatch(/^v0\./);
    expect(advertised.expiresAt).toBeTypeOf("number");

    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const echoed = (paymentPayload.extensions as Record<string, { info: Record<string, unknown> }>)[
      AUTHORIZATION_EVIDENCE
    ].info;
    expect(echoed.evidence).toBe("demo-mandate-presentation");
    expect(echoed.nonce).toBe(advertised.nonce);
    expect(server.validateExtensions(paymentRequired, paymentPayload)).toEqual({ valid: true });
  });

  it("verifies a payment when the spawned verifier allows", async () => {
    const accepts = [buildCashPaymentRequirements(AUDIENCE, "USD", "1")];
    const declared = declareAuthorizationEvidenceExtension();
    const paymentRequired = await server.createPaymentRequiredResponse(
      accepts,
      RESOURCE,
      undefined,
      declared,
    );
    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    const result = await server.verifyPayment(paymentPayload, paymentPayload.accepted, declared);
    expect(result.isValid).toBe(true);
  });

  it("aborts before verification when no evidence is presented", async () => {
    const bareClient = createCashX402Client("payer");
    const accepts = [buildCashPaymentRequirements(AUDIENCE, "USD", "1")];
    const declared = declareAuthorizationEvidenceExtension();
    const paymentRequired = await server.createPaymentRequiredResponse(
      accepts,
      RESOURCE,
      undefined,
      declared,
    );
    const paymentPayload = await bareClient.createPaymentPayload(paymentRequired);

    const result = await server.verifyPayment(paymentPayload, paymentPayload.accepted, declared);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("authorization_evidence_required");
  });

  it("relays a verifier denial and never reaches facilitator verification", async () => {
    const denyServer = await buildServer({
      verdict: "deny",
      code: "scope_exceeded",
      message: "tier not covered",
    });
    const accepts = [buildCashPaymentRequirements(AUDIENCE, "USD", "1")];
    const declared = declareAuthorizationEvidenceExtension();
    const paymentRequired = await denyServer.createPaymentRequiredResponse(
      accepts,
      RESOURCE,
      undefined,
      declared,
    );
    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    const result = await denyServer.verifyPayment(
      paymentPayload,
      paymentPayload.accepted,
      declared,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("authorization_evidence_denied: scope_exceeded");
  });

  it("denies a replayed challenge on the second verification", async () => {
    const accepts = [buildCashPaymentRequirements(AUDIENCE, "USD", "1")];
    const declared = declareAuthorizationEvidenceExtension();
    const paymentRequired = await server.createPaymentRequiredResponse(
      accepts,
      RESOURCE,
      undefined,
      declared,
    );
    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    const first = await server.verifyPayment(paymentPayload, paymentPayload.accepted, declared);
    expect(first.isValid).toBe(true);
    const replay = await server.verifyPayment(paymentPayload, paymentPayload.accepted, declared);
    expect(replay.isValid).toBe(false);
    expect(replay.invalidReason).toBe("authorization_evidence_denied: nonce_replayed");
  });
});
