/**
 * Integration tests for client extension hooks in the x402 payment flow.
 * Tests the extension enrichment mechanism using the Cash mock scheme.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { x402Client, ClientExtension } from "../../src/client";
import { x402Facilitator } from "../../src/facilitator";
import { x402ResourceServer } from "../../src/server";
import {
  buildCashPaymentRequirements,
  CashFacilitatorClient,
  CashSchemeNetworkClient,
  CashSchemeNetworkFacilitator,
  CashSchemeNetworkServer,
} from "../mocks";
import { PaymentPayload, PaymentRequired } from "../../src/types";

describe("Extension Integration Tests", () => {
  describe("Client Extension Enrichment in Full Payment Flow", () => {
    let client: x402Client;
    let server: x402ResourceServer;

    beforeEach(async () => {
      client = new x402Client().register("x402:cash", new CashSchemeNetworkClient("John"));

      const facilitator = new x402Facilitator().register(
        "x402:cash",
        new CashSchemeNetworkFacilitator(),
      );

      const facilitatorClient = new CashFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);
      server.register("x402:cash", new CashSchemeNetworkServer());
      await server.initialize();
    });

    it("should enrich extensions in the payment payload when extension key matches", async () => {
      // Register a test extension
      let enrichWasCalled = false;
      const testExtension: ClientExtension = {
        key: "testGasSponsoring",
        enrichPaymentPayload: async (
          payload: PaymentPayload,
          _paymentRequired: PaymentRequired,
        ) => {
          enrichWasCalled = true;
          const extensions = { ...(payload.extensions ?? {}) };
          extensions["testGasSponsoring"] = {
            info: {
              from: "0x1234",
              signature: "0xabcd",
              enriched: true,
            },
          };
          return { ...payload, extensions };
        },
      };
      client.registerExtension(testExtension);

      // Server builds PaymentRequired with the extension declared
      const accepts = [buildCashPaymentRequirements("Company Co.", "USD", "1")];
      const resource = {
        url: "https://company.co",
        description: "Test",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      // Add extension to the PaymentRequired (normally done by server route config)
      paymentRequired.extensions = {
        testGasSponsoring: {
          info: { description: "Test gas sponsoring", version: "1" },
          schema: {},
        },
      };

      // Client creates payload - extension should be enriched
      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      expect(enrichWasCalled).toBe(true);
      expect(paymentPayload.extensions).toBeDefined();
      const extData = (paymentPayload.extensions as Record<string, unknown>)
        ?.testGasSponsoring as Record<string, unknown>;
      expect(extData).toBeDefined();
      expect((extData.info as Record<string, unknown>)?.enriched).toBe(true);
      expect((extData.info as Record<string, unknown>)?.from).toBe("0x1234");
    });

    it("should NOT enrich extensions when extension key is not in paymentRequired", async () => {
      let enrichWasCalled = false;
      const testExtension: ClientExtension = {
        key: "missingExtension",
        enrichPaymentPayload: async (payload: PaymentPayload) => {
          enrichWasCalled = true;
          return payload;
        },
      };
      client.registerExtension(testExtension);

      const accepts = [buildCashPaymentRequirements("Company Co.", "USD", "1")];
      const resource = {
        url: "https://company.co",
        description: "Test",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      // No extensions on the paymentRequired
      await client.createPaymentPayload(paymentRequired);

      expect(enrichWasCalled).toBe(false);
    });
  });
});
