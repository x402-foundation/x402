/**
 * Integration tests for Builder Code Extension in the x402 payment flow.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import {
  buildCashPaymentRequirements,
  CashFacilitatorClient,
  CashSchemeNetworkClient,
  CashSchemeNetworkFacilitator,
  CashSchemeNetworkServer,
} from "../../../core/test/mocks";
import {
  BUILDER_CODE,
  BuilderCodeClientExtension,
  BuilderCodeFacilitatorExtension,
  declareBuilderCodeExtension,
  parseBuilderCodeSuffixFromCalldata,
  type BuilderCodeFacilitatorExtension,
} from "../../src/builder-code";

const APP = "bc_weather_svc";
const SERVICE = "bc_mobile_app";
const WALLET = "bc_facilitator";

describe("Builder Code Integration Tests", () => {
  let client: x402Client;
  let server: x402ResourceServer;
  let facilitator: x402Facilitator;

  beforeEach(async () => {
    client = new x402Client()
      .register("x402:cash", new CashSchemeNetworkClient("payer"))
      .registerExtension(new BuilderCodeClientExtension(SERVICE));

    facilitator = new x402Facilitator()
      .register("x402:cash", new CashSchemeNetworkFacilitator())
      .registerExtension(new BuilderCodeFacilitatorExtension({ builderCode: WALLET }));

    const facilitatorClient = new CashFacilitatorClient(facilitator);
    server = new x402ResourceServer(facilitatorClient);
    server.register("x402:cash", new CashSchemeNetworkServer());
    await server.initialize();
  });

  it("enriches payment payload when server declares builder-code", async () => {
    const accepts = [buildCashPaymentRequirements("merchant@example.com", "USD", "1")];
    const resource = {
      url: "https://example.com/api/weather",
      description: "Weather API",
      mimeType: "application/json",
    };
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
    paymentRequired.extensions = {
      [BUILDER_CODE]: declareBuilderCodeExtension(APP),
    };

    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    expect(paymentPayload.extensions?.[BUILDER_CODE]).toEqual({ a: APP, s: SERVICE });
  });

  it("does not enrich when builder-code is absent from payment required", async () => {
    const accepts = [buildCashPaymentRequirements("merchant@example.com", "USD", "1")];
    const resource = {
      url: "https://example.com/api/weather",
      description: "Weather API",
      mimeType: "application/json",
    };
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    expect(paymentPayload.extensions?.[BUILDER_CODE]).toBeUndefined();
  });

  it("produces a parseable settlement suffix from client and server extensions", async () => {
    const accepts = [buildCashPaymentRequirements("merchant@example.com", "USD", "1")];
    const resource = {
      url: "https://example.com/api/weather",
      description: "Weather API",
      mimeType: "application/json",
    };
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
    paymentRequired.extensions = {
      [BUILDER_CODE]: declareBuilderCodeExtension(APP),
    };

    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const builderExt = facilitator.getExtension<BuilderCodeFacilitatorExtension>(BUILDER_CODE)!;

    const suffix = builderExt.buildDataSuffix!({
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
    });

    const parsed = parseBuilderCodeSuffixFromCalldata(`0x${"00".repeat(4)}${suffix.slice(2)}`);
    expect(parsed).toEqual({ w: WALLET, a: APP, s: SERVICE });
  });

  it("settlement suffix encodes only wallet code when server did not declare builder-code", async () => {
    const accepts = [buildCashPaymentRequirements("merchant@example.com", "USD", "1")];
    const resource = {
      url: "https://example.com/api/weather",
      description: "Weather API",
      mimeType: "application/json",
    };
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    expect(paymentPayload.extensions?.[BUILDER_CODE]).toBeUndefined();

    const builderExt = facilitator.getExtension<BuilderCodeFacilitatorExtension>(BUILDER_CODE)!;
    const suffix = builderExt.buildDataSuffix!({
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
    });

    const parsed = parseBuilderCodeSuffixFromCalldata(`0x${"00".repeat(4)}${suffix.slice(2)}`);
    expect(parsed).toEqual({ w: WALLET });
  });
});
