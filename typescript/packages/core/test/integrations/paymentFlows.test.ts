import { beforeEach, describe, expect, it } from "vitest";
import { x402HTTPClient } from "../../src/client";
import { x402Facilitator } from "../../src/facilitator";
import {
  FacilitatorClient,
  HTTPAdapter,
  SettlePhase,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "../../src/server";
import {
  CashFacilitatorClient,
  createCashX402Client,
  CashSchemeNetworkFacilitator,
  MockAuthorizeSchemeNetworkServer,
  MockEscrowSchemeNetworkServer,
  MockUpfrontSchemeNetworkServer,
} from "../mocks";
import {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkServer,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "../../src/types";
import { decodePaymentResponseHeader } from "../../src/http";

/**
 * Wraps a facilitator client to count verify/settle calls for payment-flow assertions.
 */
class CountingFacilitatorClient implements FacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;

  /**
   * @param inner - Underlying facilitator client
   */
  constructor(private readonly inner: FacilitatorClient) {}

  /**
   * @returns Supported kinds from the inner client
   */
  getSupported(): Promise<SupportedResponse> {
    return this.inner.getSupported();
  }

  /**
   * @param payload - Payment payload
   * @param requirements - Payment requirements
   * @returns Verify response from the inner client
   */
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.verifyCalls++;
    return this.inner.verify(payload, requirements);
  }

  /**
   * @param payload - Payment payload
   * @param requirements - Payment requirements
   * @returns Settle response from the inner client
   */
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls++;
    return this.inner.settle(payload, requirements);
  }
}

describe("Payment flow integration (MockAuthorize / MockUpfront / MockEscrow)", () => {
  const routes = {
    "/api/protected": {
      accepts: {
        scheme: "cash",
        payTo: "merchant@example.com",
        price: "$0.10",
        network: "x402:cash" as Network,
      },
      description: "Access to protected API",
      mimeType: "application/json",
    },
  };

  let client: x402HTTPClient;
  let httpServer: x402HTTPResourceServer;
  let resourceServer: x402ResourceServer;
  let facilitatorClient: CountingFacilitatorClient;
  let paymentSignatureHeader: string;

  /**
   * @param schemeServer - Cash server variant declaring a payment flow
   */
  async function setup(schemeServer: SchemeNetworkServer) {
    const facilitator = new x402Facilitator().register(
      "x402:cash",
      new CashSchemeNetworkFacilitator(),
    );
    facilitatorClient = new CountingFacilitatorClient(new CashFacilitatorClient(facilitator));

    const paymentClient = createCashX402Client("John");
    client = new x402HTTPClient(paymentClient);

    resourceServer = new x402ResourceServer(facilitatorClient);
    resourceServer.register("x402:cash", schemeServer);
    await resourceServer.initialize();

    httpServer = new x402HTTPResourceServer(resourceServer, routes);

    // Obtain a signed PAYMENT-SIGNATURE for the protected route
    const unpaidAdapter: HTTPAdapter = {
      getHeader: () => undefined,
      getMethod: () => "GET",
      getPath: () => "/api/protected",
      getUrl: () => "https://example.com/api/protected",
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "TestClient/1.0",
    };
    const unpaid = await httpServer.processHTTPRequest({
      adapter: unpaidAdapter,
      path: "/api/protected",
      method: "GET",
    });
    expect(unpaid.type).toBe("payment-error");
    if (unpaid.type !== "payment-error") return;

    const paymentRequired = client.getPaymentRequiredResponse(
      name => unpaid.response.headers[name],
      unpaid.response.body,
    );
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const headers = await client.encodePaymentSignatureHeader(paymentPayload);
    paymentSignatureHeader = headers["PAYMENT-SIGNATURE"];

    facilitatorClient.verifyCalls = 0;
    facilitatorClient.settleCalls = 0;
  }

  /**
   * @returns Adapter that presents the pre-built PAYMENT-SIGNATURE
   */
  function paidAdapter(): HTTPAdapter {
    return {
      getHeader: (name: string) =>
        name.toUpperCase() === "PAYMENT-SIGNATURE" ? paymentSignatureHeader : undefined,
      getMethod: () => "GET",
      getPath: () => "/api/protected",
      getUrl: () => "https://example.com/api/protected",
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "TestClient/1.0",
    };
  }

  describe("MockAuthorize", () => {
    beforeEach(async () => {
      await setup(new MockAuthorizeSchemeNetworkServer());
    });

    it("verifies before handler and settles after", async () => {
      const result = await httpServer.processHTTPRequest({
        adapter: paidAdapter(),
        path: "/api/protected",
        method: "GET",
      });
      expect(result.type).toBe("payment-verified");
      if (result.type !== "payment-verified") return;

      expect(result.beforeHandlerSettlement).toBeUndefined();
      expect(facilitatorClient.verifyCalls).toBe(1);
      expect(facilitatorClient.settleCalls).toBe(0);

      const settle = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        undefined,
        undefined,
        result.beforeHandlerSettlement,
      );
      expect(settle.success).toBe(true);
      expect(facilitatorClient.verifyCalls).toBe(1);
      expect(facilitatorClient.settleCalls).toBe(1);
      if (settle.success) {
        expect(settle.headers["PAYMENT-RESPONSE"]).toBeDefined();
      }
    });
  });

  describe("MockUpfront", () => {
    beforeEach(async () => {
      await setup(new MockUpfrontSchemeNetworkServer());
    });

    it("settles before handler and echoes receipt without a second settle", async () => {
      const result = await httpServer.processHTTPRequest({
        adapter: paidAdapter(),
        path: "/api/protected",
        method: "GET",
      });
      expect(result.type).toBe("payment-verified");
      if (result.type !== "payment-verified") return;

      expect(result.beforeHandlerSettlement?.phase).toBe("before-handler");
      expect(result.beforeHandlerSettlement?.flow).toBe("upfront");
      expect(facilitatorClient.verifyCalls).toBe(0);
      expect(facilitatorClient.settleCalls).toBe(1);

      const settle = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        undefined,
        undefined,
        result.beforeHandlerSettlement,
      );
      expect(settle.success).toBe(true);
      // Echo path — no second facilitator settle
      expect(facilitatorClient.settleCalls).toBe(1);
      if (settle.success) {
        expect(settle.headers["PAYMENT-RESPONSE"]).toBeDefined();
        expect(settle.transaction).toBe(result.beforeHandlerSettlement!.result.transaction);
      }
    });
  });

  describe("MockEscrow", () => {
    beforeEach(async () => {
      await setup(new MockEscrowSchemeNetworkServer());
    });

    it("settles before and after handler", async () => {
      const result = await httpServer.processHTTPRequest({
        adapter: paidAdapter(),
        path: "/api/protected",
        method: "GET",
      });
      expect(result.type).toBe("payment-verified");
      if (result.type !== "payment-verified") return;

      expect(result.beforeHandlerSettlement?.phase).toBe("before-handler");
      expect(result.beforeHandlerSettlement?.flow).toBe("escrow");
      expect(facilitatorClient.verifyCalls).toBe(0);
      expect(facilitatorClient.settleCalls).toBe(1);

      const settle = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        undefined,
        undefined,
        result.beforeHandlerSettlement,
      );
      expect(settle.success).toBe(true);
      expect(facilitatorClient.settleCalls).toBe(2);
      if (settle.success) {
        expect(settle.headers["PAYMENT-RESPONSE"]).toBeDefined();
      }
    });

    it("cancels after deposit with settledPhases and deposit receipt", async () => {
      let settledPhases: readonly SettlePhase[] | undefined;
      resourceServer.onVerifiedPaymentCanceled(async ctx => {
        settledPhases = ctx.settledPhases;
        expect(ctx.phase).toBe("cancel");
        expect(ctx.reason).toBe("handler_failed");
      });

      const result = await httpServer.processHTTPRequest({
        adapter: paidAdapter(),
        path: "/api/protected",
        method: "GET",
      });
      expect(result.type).toBe("payment-verified");
      if (result.type !== "payment-verified") return;

      expect(result.beforeHandlerSettlement?.phase).toBe("before-handler");
      expect(facilitatorClient.settleCalls).toBe(1);

      await result.cancellationDispatcher.cancel({
        reason: "handler_failed",
        responseStatus: 500,
      });
      expect(settledPhases).toEqual(["before-handler"]);
      // Cancel does not invoke a second facilitator settle
      expect(facilitatorClient.settleCalls).toBe(1);

      const receiptHeaders = httpServer.createCompletedSettlementHeaders(
        result.beforeHandlerSettlement!,
      );
      expect(decodePaymentResponseHeader(receiptHeaders["PAYMENT-RESPONSE"])).toEqual(
        expect.objectContaining({
          success: true,
          transaction: result.beforeHandlerSettlement!.result.transaction,
        }),
      );
    });
  });
});
