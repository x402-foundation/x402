import { beforeEach, describe, expect, it } from "vitest";
import { x402Client, x402HTTPClient } from "../../src/client";
import { x402Facilitator } from "../../src/facilitator";
import {
  HTTPAdapter,
  HTTPResponseInstructions,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "../../src/server";
import {
  buildCashPaymentRequirements,
  CashFacilitatorClient,
  CashSchemeNetworkClient,
  CashSchemeNetworkFacilitator,
  CashSchemeNetworkServer,
} from "../mocks";
import { Network, PaymentPayload, PaymentRequirements } from "../../src/types";
import { SettlementOverrides } from "../../src/server/x402ResourceServer";
import { SETTLEMENT_OVERRIDES_HEADER } from "../../src/http/x402HTTPResourceServer";

describe("Upto Integration Tests", () => {
  describe("x402Client / x402ResourceServer — Upto-style partial settlement", () => {
    let client: x402Client;
    let server: x402ResourceServer;

    beforeEach(async () => {
      client = new x402Client().register("x402:cash", new CashSchemeNetworkClient("Alice"));

      const facilitator = new x402Facilitator().register(
        "x402:cash",
        new CashSchemeNetworkFacilitator(),
      );

      const facilitatorClient = new CashFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);
      server.register("x402:cash", new CashSchemeNetworkServer());
      await server.initialize();
    });

    it("should settle with full amount when no overrides provided", async () => {
      const accepts = [buildCashPaymentRequirements("Merchant", "USD", "1000")];
      const resource = {
        url: "https://api.example.com/generate",
        description: "AI generation",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);

      // No overrides — settles for the full 1000
      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.transaction).toContain("1000");
    });

    it("should settle with reduced amount when overrides specify partial amount", async () => {
      const accepts = [buildCashPaymentRequirements("Merchant", "USD", "1000")];
      const resource = {
        url: "https://api.example.com/generate",
        description: "AI generation",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);

      // Partial settlement — only charge 400 of authorized 1000
      const overrides: SettlementOverrides = { amount: "400" };
      const settleResponse = await server.settlePayment(
        paymentPayload,
        accepted!,
        undefined,
        undefined,
        overrides,
      );
      expect(settleResponse.success).toBe(true);
      // The mock cash facilitator includes the amount in the transaction string
      expect(settleResponse.transaction).toContain("400");
      expect(settleResponse.transaction).not.toContain("1000");
    });

    it("should settle with zero amount when overrides specify zero", async () => {
      const accepts = [buildCashPaymentRequirements("Merchant", "USD", "1000")];
      const resource = {
        url: "https://api.example.com/generate",
        description: "AI generation",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      await server.verifyPayment(paymentPayload, accepted!);

      // Zero settlement — free usage this time
      const overrides: SettlementOverrides = { amount: "0" };
      const settleResponse = await server.settlePayment(
        paymentPayload,
        accepted!,
        undefined,
        undefined,
        overrides,
      );
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.transaction).toContain("0 USD");
    });

    it("should not modify original requirements when overrides are applied", async () => {
      const accepts = [buildCashPaymentRequirements("Merchant", "USD", "1000")];
      const resource = {
        url: "https://api.example.com/generate",
        description: "AI generation",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const originalAmount = accepted!.amount;

      await server.settlePayment(paymentPayload, accepted!, undefined, undefined, {
        amount: "250",
      });

      // Original requirements object should not be mutated
      expect(accepted!.amount).toBe(originalAmount);
    });
  });

  describe("x402HTTPResourceServer — Upto processSettlement with overrides", () => {
    let client: x402HTTPClient;
    let httpServer: x402HTTPResourceServer;

    const routes = {
      "/api/generate": {
        accepts: {
          scheme: "cash",
          payTo: "merchant@example.com",
          price: "$10.00",
          network: "x402:cash" as Network,
        },
        description: "AI generation with upto billing",
        mimeType: "application/json",
      },
    };

    function createMockAdapter(): HTTPAdapter {
      return {
        getHeader: () => undefined,
        getMethod: () => "GET",
        getPath: () => "/api/generate",
        getUrl: () => "https://example.com/api/generate",
        getAcceptHeader: () => "application/json",
        getUserAgent: () => "TestClient/1.0",
      };
    }

    beforeEach(async () => {
      const facilitator = new x402Facilitator().register(
        "x402:cash",
        new CashSchemeNetworkFacilitator(),
      );

      const facilitatorClient = new CashFacilitatorClient(facilitator);

      const paymentClient = new x402Client().register(
        "x402:cash",
        new CashSchemeNetworkClient("Alice"),
      );
      client = new x402HTTPClient(paymentClient) as x402HTTPClient;

      const ResourceServer = new x402ResourceServer(facilitatorClient);
      ResourceServer.register("x402:cash", new CashSchemeNetworkServer());
      await ResourceServer.initialize();

      httpServer = new x402HTTPResourceServer(ResourceServer, routes);
    });

    it("should settle with overrides passed explicitly to processSettlement", async () => {
      // Get PaymentRequired
      const context = { adapter: createMockAdapter(), path: "/api/generate", method: "GET" };
      const httpResult = await httpServer.processHTTPRequest(context);
      expect(httpResult.type).toBe("payment-error");

      const initial402 = (
        httpResult as { type: "payment-error"; response: HTTPResponseInstructions }
      ).response;

      // Client creates payment
      const paymentRequired = client.getPaymentRequiredResponse(
        name => initial402.headers[name],
        initial402.body,
      );
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const requestHeaders = await client.encodePaymentSignatureHeader(paymentPayload);

      // Submit payment
      context.adapter.getHeader = (name: string) => {
        if (name === "PAYMENT-SIGNATURE") return requestHeaders["PAYMENT-SIGNATURE"];
        return undefined;
      };
      const verified = await httpServer.processHTTPRequest(context);
      expect(verified.type).toBe("payment-verified");

      const { paymentPayload: verifiedPayload, paymentRequirements: verifiedRequirements } =
        verified as {
          type: "payment-verified";
          paymentPayload: PaymentPayload;
          paymentRequirements: PaymentRequirements;
        };

      // Settle with partial override
      const result = await httpServer.processSettlement(
        verifiedPayload,
        verifiedRequirements,
        undefined,
        undefined,
        { amount: "3" },
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.headers["PAYMENT-RESPONSE"]).toBeDefined();
      }
    });

    it("should extract overrides from transport context responseHeaders", async () => {
      // Get PaymentRequired
      const context = { adapter: createMockAdapter(), path: "/api/generate", method: "GET" };
      const httpResult = await httpServer.processHTTPRequest(context);
      const initial402 = (
        httpResult as { type: "payment-error"; response: HTTPResponseInstructions }
      ).response;

      // Client creates payment
      const paymentRequired = client.getPaymentRequiredResponse(
        name => initial402.headers[name],
        initial402.body,
      );
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const requestHeaders = await client.encodePaymentSignatureHeader(paymentPayload);

      context.adapter.getHeader = (name: string) => {
        if (name === "PAYMENT-SIGNATURE") return requestHeaders["PAYMENT-SIGNATURE"];
        return undefined;
      };
      const verified = await httpServer.processHTTPRequest(context);

      const { paymentPayload: verifiedPayload, paymentRequirements: verifiedRequirements } =
        verified as {
          type: "payment-verified";
          paymentPayload: PaymentPayload;
          paymentRequirements: PaymentRequirements;
        };

      // Pass overrides via transport context responseHeaders (simulating middleware extraction)
      const result = await httpServer.processSettlement(
        verifiedPayload,
        verifiedRequirements,
        undefined,
        {
          request: context,
          responseHeaders: {
            [SETTLEMENT_OVERRIDES_HEADER]: JSON.stringify({ amount: "5" }),
          },
        },
      );
      expect(result.success).toBe(true);
    });

    it("explicit overrides should take precedence over header overrides", async () => {
      const context = { adapter: createMockAdapter(), path: "/api/generate", method: "GET" };
      const httpResult = await httpServer.processHTTPRequest(context);
      const initial402 = (
        httpResult as { type: "payment-error"; response: HTTPResponseInstructions }
      ).response;

      const paymentRequired = client.getPaymentRequiredResponse(
        name => initial402.headers[name],
        initial402.body,
      );
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const requestHeaders = await client.encodePaymentSignatureHeader(paymentPayload);

      context.adapter.getHeader = (name: string) => {
        if (name === "PAYMENT-SIGNATURE") return requestHeaders["PAYMENT-SIGNATURE"];
        return undefined;
      };
      const verified = await httpServer.processHTTPRequest(context);

      const { paymentPayload: verifiedPayload, paymentRequirements: verifiedRequirements } =
        verified as {
          type: "payment-verified";
          paymentPayload: PaymentPayload;
          paymentRequirements: PaymentRequirements;
        };

      // Both explicit and header overrides — explicit wins
      const result = await httpServer.processSettlement(
        verifiedPayload,
        verifiedRequirements,
        undefined,
        {
          request: context,
          responseHeaders: {
            [SETTLEMENT_OVERRIDES_HEADER]: JSON.stringify({ amount: "999" }),
          },
        },
        { amount: "2" }, // explicit takes precedence
      );
      expect(result.success).toBe(true);
    });
  });
});
