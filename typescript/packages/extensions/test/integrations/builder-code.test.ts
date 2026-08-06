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
  type BuilderCodeFacilitatorExtension as BuilderCodeFacilitatorExtensionType,
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

    expect(paymentPayload.extensions?.[BUILDER_CODE]).toEqual({
      info: { a: APP, s: [SERVICE] },
      schema: expect.any(Object),
    });
  });

  it("merges server and client service codes when both declare s", async () => {
    const accepts = [buildCashPaymentRequirements("merchant@example.com", "USD", "1")];
    const resource = {
      url: "https://example.com/api/weather",
      description: "Weather API",
      mimeType: "application/json",
    };
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
    paymentRequired.extensions = {
      [BUILDER_CODE]: declareBuilderCodeExtension(APP, "bc_server_sdk"),
    };

    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    expect(paymentPayload.extensions?.[BUILDER_CODE]).toEqual({
      info: { a: APP, s: [SERVICE, "bc_server_sdk"] },
      schema: expect.any(Object),
    });
    expect(server.validateExtensions(paymentRequired, paymentPayload)).toEqual({ valid: true });
  });

  it("does not drop any service codes when client and server each use their full reservation", async () => {
    // Regression test for the reported policy issue: a client and server each declaring
    // up to their own dedicated reservation must not crowd out the other's entries.
    const layeredClient = new x402Client()
      .register("x402:cash", new CashSchemeNetworkClient("payer"))
      .registerExtension(new BuilderCodeClientExtension(["bc_c1", "bc_c2", "bc_c3"]));

    const accepts = [buildCashPaymentRequirements("merchant@example.com", "USD", "1")];
    const resource = {
      url: "https://example.com/api/weather",
      description: "Weather API",
      mimeType: "application/json",
    };
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
    paymentRequired.extensions = {
      [BUILDER_CODE]: declareBuilderCodeExtension(APP, ["bc_s1", "bc_s2", "bc_s3"]),
    };

    const paymentPayload = await layeredClient.createPaymentPayload(paymentRequired);

    expect(paymentPayload.extensions?.[BUILDER_CODE]).toEqual({
      info: { a: APP, s: ["bc_c1", "bc_c2", "bc_c3", "bc_s1", "bc_s2", "bc_s3"] },
      schema: expect.any(Object),
    });
    expect(server.validateExtensions(paymentRequired, paymentPayload)).toEqual({ valid: true });

    const builderExt = facilitator.getExtension<BuilderCodeFacilitatorExtensionType>(BUILDER_CODE)!;
    const suffix = builderExt.buildDataSuffix!({
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
    });
    if (!suffix) {
      throw new Error("Expected builder-code suffix");
    }
    const parsed = parseBuilderCodeSuffixFromCalldata(`0x${"00".repeat(4)}${suffix.slice(2)}`);
    expect(parsed).toEqual({
      w: WALLET,
      a: APP,
      s: ["bc_c1", "bc_c2", "bc_c3", "bc_s1", "bc_s2", "bc_s3"],
    });
  });

  it("appends the facilitator's own service code at settlement", async () => {
    const facilitatorWithServiceCode = new x402Facilitator()
      .register("x402:cash", new CashSchemeNetworkFacilitator())
      .registerExtension(
        new BuilderCodeFacilitatorExtension({ builderCode: WALLET, serviceCode: "bc_fac_sdk" }),
      );
    const facilitatorClient = new CashFacilitatorClient(facilitatorWithServiceCode);
    const serverWithFacilitatorCode = new x402ResourceServer(facilitatorClient);
    serverWithFacilitatorCode.register("x402:cash", new CashSchemeNetworkServer());
    await serverWithFacilitatorCode.initialize();

    const accepts = [buildCashPaymentRequirements("merchant@example.com", "USD", "1")];
    const resource = {
      url: "https://example.com/api/weather",
      description: "Weather API",
      mimeType: "application/json",
    };
    const paymentRequired = await serverWithFacilitatorCode.createPaymentRequiredResponse(
      accepts,
      resource,
    );
    paymentRequired.extensions = {
      [BUILDER_CODE]: declareBuilderCodeExtension(APP),
    };

    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const builderExt =
      facilitatorWithServiceCode.getExtension<BuilderCodeFacilitatorExtensionType>(BUILDER_CODE)!;

    const suffix = builderExt.buildDataSuffix!({
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
    });
    if (!suffix) {
      throw new Error("Expected builder-code suffix");
    }

    const parsed = parseBuilderCodeSuffixFromCalldata(`0x${"00".repeat(4)}${suffix.slice(2)}`);
    expect(parsed).toEqual({ w: WALLET, a: APP, s: [SERVICE, "bc_fac_sdk"] });
  });

  it("attaches service codes when builder-code is absent from payment required", async () => {
    const accepts = [buildCashPaymentRequirements("merchant@example.com", "USD", "1")];
    const resource = {
      url: "https://example.com/api/weather",
      description: "Weather API",
      mimeType: "application/json",
    };
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    expect(paymentPayload.extensions?.[BUILDER_CODE]).toEqual({
      info: { s: [SERVICE] },
    });
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
    const builderExt = facilitator.getExtension<BuilderCodeFacilitatorExtensionType>(BUILDER_CODE)!;

    const suffix = builderExt.buildDataSuffix!({
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
    });
    if (!suffix) {
      throw new Error("Expected builder-code suffix");
    }

    const parsed = parseBuilderCodeSuffixFromCalldata(`0x${"00".repeat(4)}${suffix.slice(2)}`);
    expect(parsed).toEqual({ w: WALLET, a: APP, s: [SERVICE] });
  });

  it("attributes multiple service codes from a layered client end-to-end", async () => {
    const layeredClient = new x402Client()
      .register("x402:cash", new CashSchemeNetworkClient("payer"))
      .registerExtension(new BuilderCodeClientExtension(["bc_base_mcp", "bc_demo_app"]));

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

    const paymentPayload = await layeredClient.createPaymentPayload(paymentRequired);
    const builderExt = facilitator.getExtension<BuilderCodeFacilitatorExtensionType>(BUILDER_CODE)!;

    const suffix = builderExt.buildDataSuffix!({
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
    });
    if (!suffix) {
      throw new Error("Expected builder-code suffix");
    }

    const parsed = parseBuilderCodeSuffixFromCalldata(`0x${"00".repeat(4)}${suffix.slice(2)}`);
    expect(parsed).toEqual({ w: WALLET, a: APP, s: ["bc_base_mcp", "bc_demo_app"] });
  });

  it("settlement suffix encodes wallet and service codes when server did not declare builder-code", async () => {
    const accepts = [buildCashPaymentRequirements("merchant@example.com", "USD", "1")];
    const resource = {
      url: "https://example.com/api/weather",
      description: "Weather API",
      mimeType: "application/json",
    };
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    expect(paymentPayload.extensions?.[BUILDER_CODE]).toEqual({
      info: { s: [SERVICE] },
    });

    const builderExt = facilitator.getExtension<BuilderCodeFacilitatorExtensionType>(BUILDER_CODE)!;
    const suffix = builderExt.buildDataSuffix!({
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
    });
    if (!suffix) {
      throw new Error("Expected builder-code suffix");
    }

    const parsed = parseBuilderCodeSuffixFromCalldata(`0x${"00".repeat(4)}${suffix.slice(2)}`);
    expect(parsed).toEqual({ w: WALLET, s: [SERVICE] });
  });
});
