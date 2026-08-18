import { describe, it, expect, vi, afterEach } from "vitest";
import {
  x402ResourceServer,
  SettleContext,
  SettlePhase,
  PAYMENT_FLOWS,
  SDK_DEFAULT_ASSET_TRANSFER_METHOD,
  applyPaymentFlowWireExtra,
  resolvePaymentFlow,
  resolveFailurePathSettlement,
} from "../../../src/server";
import { x402HTTPResourceServer } from "../../../src/http/x402HTTPResourceServer";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildSupportedResponse,
  buildVerifyResponse,
  buildSettleResponse,
  buildPaymentPayload,
  buildPaymentRequirements,
} from "../../mocks";
import { Network, PaymentFlowName } from "../../../src/types";
import type { HTTPAdapter } from "../../../src/http/x402HTTPResourceServer";
import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from "../../../src/http";

/**
 *
 */
class MockHTTPAdapter implements HTTPAdapter {
  private headers: Record<string, string> = {};

  /**
   *
   * @param headers
   */
  constructor(headers: Record<string, string> = {}) {
    this.headers = headers;
  }

  /**
   *
   * @param name
   */
  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  /**
   *
   */
  getMethod(): string {
    return "GET";
  }

  /**
   *
   */
  getPath(): string {
    return "/api/test";
  }

  /**
   *
   */
  getUrl(): string {
    return "https://example.com/api/test";
  }

  /**
   *
   */
  getAcceptHeader(): string {
    return "application/json";
  }

  /**
   *
   */
  getUserAgent(): string {
    return "TestClient/1.0";
  }
}

/**
 *
 * @param flow
 */
function schemeWithFlow(flow: PaymentFlowName): MockSchemeNetworkServer {
  return Object.assign(
    new MockSchemeNetworkServer("exact", {
      amount: "1000000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      extra: {},
    }),
    {
      paymentFlows: {
        default: { supported: [flow], default: flow },
      },
    },
  );
}

const exactEvmLikeScheme = {
  scheme: "exact",
  defaultAssetTransferMethod: "eip3009",
  paymentFlows: {
    eip3009: {
      supported: ["authorization", "upfront"] as const,
      default: "authorization" as const,
    },
    permit2: {
      supported: ["authorization", "upfront"] as const,
      default: "authorization" as const,
    },
  },
};

describe("payment flows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("resolvePaymentFlow", () => {
    it("omits ATM and paymentFlow to scheme defaults", () => {
      expect(
        resolvePaymentFlow(exactEvmLikeScheme, buildPaymentRequirements({ extra: {} })),
      ).toEqual({ assetTransferMethod: "eip3009", paymentFlow: "authorization" });
    });

    it("resolves explicit defaults the same as omitted", () => {
      expect(
        resolvePaymentFlow(
          exactEvmLikeScheme,
          buildPaymentRequirements({
            extra: { assetTransferMethod: "eip3009", paymentFlow: "authorization" },
          }),
        ),
      ).toEqual({ assetTransferMethod: "eip3009", paymentFlow: "authorization" });
    });

    it("resolves upfront and permit2 ATM", () => {
      expect(
        resolvePaymentFlow(
          exactEvmLikeScheme,
          buildPaymentRequirements({
            extra: { assetTransferMethod: "permit2", paymentFlow: "upfront" },
          }),
        ),
      ).toEqual({ assetTransferMethod: "permit2", paymentFlow: "upfront" });
    });

    it("throws on unknown ATM", () => {
      expect(() =>
        resolvePaymentFlow(
          exactEvmLikeScheme,
          buildPaymentRequirements({ extra: { assetTransferMethod: "unknown" } }),
        ),
      ).toThrow(/does not support assetTransferMethod "unknown"/);
    });

    it("throws on unsupported flow", () => {
      expect(() =>
        resolvePaymentFlow(
          exactEvmLikeScheme,
          buildPaymentRequirements({ extra: { paymentFlow: "escrow" } }),
        ),
      ).toThrow(/does not support paymentFlow "escrow"/);
    });
  });

  describe("resolveFailurePathSettlement", () => {
    const network = "eip155:8453" as Network;

    it("prefers successful cancel receipt over before-handler deposit", () => {
      const cancelSettlement = buildSettleResponse({
        success: true,
        amount: "0",
        transaction: "0xrefund",
        network,
      });
      const beforeHandlerSettlement = {
        result: buildSettleResponse({
          success: true,
          amount: "100000",
          transaction: "0xdeposit",
          network,
        }),
      };

      expect(
        resolveFailurePathSettlement(
          cancelSettlement,
          beforeHandlerSettlement,
          buildPaymentPayload(),
        ),
      ).toEqual(cancelSettlement);
    });

    it("builds failed cancel receipt with deposit recovery extra", () => {
      const cancelSettlement = buildSettleResponse({
        success: false,
        errorReason: "refund_failed",
        transaction: "should-not-appear",
        network,
      });
      const beforeHandlerSettlement = {
        result: buildSettleResponse({
          success: true,
          amount: "100000",
          transaction: "0xdeposit",
          network,
        }),
      };
      const paymentPayload = buildPaymentPayload({
        payload: { channelId: "channel-123" },
      });

      expect(
        resolveFailurePathSettlement(cancelSettlement, beforeHandlerSettlement, paymentPayload),
      ).toEqual({
        success: false,
        errorReason: "refund_failed",
        errorMessage: undefined,
        payer: cancelSettlement.payer,
        transaction: "",
        network,
        extensions: cancelSettlement.extensions,
        extra: {
          depositTransaction: "0xdeposit",
          depositAmount: "100000",
          channelId: "channel-123",
        },
      });
    });

    it("echoes before-handler deposit when cancel returns undefined", () => {
      const beforeHandlerSettlement = {
        result: buildSettleResponse({
          success: true,
          amount: "100000",
          transaction: "0xdeposit",
          network,
        }),
      };

      expect(resolveFailurePathSettlement(undefined, beforeHandlerSettlement)).toEqual(
        beforeHandlerSettlement.result,
      );
    });

    it("returns undefined when neither cancel nor before-handler settlement applies", () => {
      expect(resolveFailurePathSettlement(undefined)).toBeUndefined();
      expect(
        resolveFailurePathSettlement(undefined, undefined, buildPaymentPayload()),
      ).toBeUndefined();
    });
  });

  describe("applyPaymentFlowWireExtra", () => {
    it("leaves authorization alone", () => {
      expect(
        applyPaymentFlowWireExtra(
          { name: "USDC" },
          { assetTransferMethod: "eip3009", paymentFlow: "authorization" },
        ),
      ).toEqual({ name: "USDC" });
    });

    it("forces non-authorization paymentFlow onto extra", () => {
      expect(
        applyPaymentFlowWireExtra({}, { assetTransferMethod: "eip3009", paymentFlow: "upfront" }),
      ).toEqual({ paymentFlow: "upfront" });
      expect(
        applyPaymentFlowWireExtra({}, { assetTransferMethod: "default", paymentFlow: "escrow" }),
      ).toEqual({ paymentFlow: "escrow" });
    });

    it("strips SDK ATM sentinel", () => {
      expect(
        applyPaymentFlowWireExtra(
          { assetTransferMethod: SDK_DEFAULT_ASSET_TRANSFER_METHOD, name: "USDC" },
          { assetTransferMethod: SDK_DEFAULT_ASSET_TRANSFER_METHOD, paymentFlow: "authorization" },
        ),
      ).toEqual({ name: "USDC" });
    });
  });

  describe("vocabulary", () => {
    it("authorization phase table", () => {
      expect(PAYMENT_FLOWS.authorization).toEqual({
        verifyBeforeHandler: true,
        settleBeforeHandler: false,
        settleAfterHandler: true,
      });
    });

    it("getPaymentFlow returns table default when requirements omit paymentFlow", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
      );
      const server = new x402ResourceServer(mockClient);
      server.register("eip155:8453" as Network, new MockSchemeNetworkServer("exact"));
      await server.initialize();

      expect(
        server.getPaymentFlow(
          buildPaymentPayload(),
          buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
        ),
      ).toBe("authorization");
    });

    it("buildPaymentRequirements rejects unsupported escrow for ExactEvm-like table", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
      );
      const server = new x402ResourceServer(mockClient);
      server.register(
        "eip155:8453" as Network,
        Object.assign(new MockSchemeNetworkServer("exact"), {
          defaultAssetTransferMethod: "eip3009",
          paymentFlows: exactEvmLikeScheme.paymentFlows,
        }),
      );
      await server.initialize();

      await expect(
        server.buildPaymentRequirements({
          scheme: "exact",
          payTo: "0xabc",
          price: "$1.00",
          network: "eip155:8453" as Network,
          extra: { paymentFlow: "escrow" },
        }),
      ).rejects.toThrow(/does not support paymentFlow "escrow"/);
    });

    it("buildPaymentRequirements emits paymentFlow for escrow-default mock", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
      );
      const server = new x402ResourceServer(mockClient);
      server.register("eip155:8453" as Network, schemeWithFlow("escrow"));
      await server.initialize();

      const [requirement] = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: "0xabc",
        price: "$1.00",
        network: "eip155:8453" as Network,
      });

      expect(requirement.extra?.paymentFlow).toBe("escrow");
      expect(requirement.extra).not.toHaveProperty("assetTransferMethod");
    });
  });

  describe("settlePayment phase", () => {
    it("passes phase on SettleContext to beforeSettle hooks", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true }),
      );
      const server = new x402ResourceServer(mockClient);
      server.register("eip155:8453" as Network, new MockSchemeNetworkServer("exact"));
      await server.initialize();

      const phases: SettlePhase[] = [];
      server.onBeforeSettle(async (ctx: SettleContext) => {
        phases.push(ctx.phase);
      });

      await server.settlePayment(
        buildPaymentPayload({
          accepted: buildPaymentRequirements({
            scheme: "exact",
            network: "eip155:8453" as Network,
          }),
        }),
        buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
        undefined,
        undefined,
        undefined,
        "before-handler",
      );

      expect(phases).toEqual(["before-handler"]);
    });

    it("allows the same enrichment keys on a second settle via settle-local payload copy", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true }),
      );
      const server = new x402ResourceServer(mockClient);
      let enrichCalls = 0;
      server.register(
        "eip155:8453" as Network,
        Object.assign(new MockSchemeNetworkServer("exact"), {
          enrichSettlementPayload: async (ctx: SettleContext) => {
            enrichCalls += 1;
            return { settlePhase: ctx.phase === "before-handler" ? "deposit" : "charge" };
          },
        }),
      );
      await server.initialize();

      const payload = buildPaymentPayload({
        accepted: buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
        }),
        payload: { signature: "sig" },
      });
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      await server.settlePayment(
        payload,
        requirements,
        undefined,
        undefined,
        undefined,
        "before-handler",
      );
      await server.settlePayment(
        payload,
        requirements,
        undefined,
        undefined,
        undefined,
        "after-handler",
      );

      expect(enrichCalls).toBe(2);
      expect(mockClient.settleCalls).toHaveLength(2);
      expect(mockClient.settleCalls[0].payload.payload).toEqual({
        signature: "sig",
        settlePhase: "deposit",
      });
      expect(mockClient.settleCalls[1].payload.payload).toEqual({
        signature: "sig",
        settlePhase: "charge",
      });
      expect(payload.payload).toEqual({ signature: "sig" });
    });
  });

  describe("cancellation dispatcher settledPhases", () => {
    it("exposes completed settle phases on cancel", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true, transaction: "0xdeposit" }),
      );
      const server = new x402ResourceServer(mockClient);
      server.register("eip155:8453" as Network, schemeWithFlow("escrow"));
      await server.initialize();

      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });
      const payload = buildPaymentPayload({ accepted: requirements });
      const handle = server.createPaymentCancellationDispatcher(
        payload,
        requirements,
        undefined,
        undefined,
        ["before-handler"],
      );

      let settledPhases: readonly SettlePhase[] | undefined;
      server.onVerifiedPaymentCanceled(async ctx => {
        settledPhases = ctx.settledPhases;
        expect(ctx.phase).toBe("cancel");
      });

      await handle.cancel({ reason: "handler_failed", responseStatus: 500 });
      expect(settledPhases).toEqual(["before-handler"]);
    });
  });

  describe("HTTP orchestration", () => {
    let ResourceServer: x402ResourceServer;
    let mockFacilitator: MockFacilitatorClient;

    /**
     *
     * @param flow
     */
    async function setup(flow: PaymentFlowName) {
      mockFacilitator = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        buildVerifyResponse({ isValid: true }),
        buildSettleResponse({ success: true, transaction: "0xtx" }),
      );
      ResourceServer = new x402ResourceServer(mockFacilitator);
      ResourceServer.register("eip155:8453" as Network, schemeWithFlow(flow));
      await ResourceServer.initialize();
      return new x402HTTPResourceServer(ResourceServer, {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00",
            network: "eip155:8453" as Network,
          },
        },
      });
    }

    /**
     *
     * @param httpServer
     * @param flow - Payment flow used when building accepted requirements to match the 402 wire
     */
    async function verifiedRequest(httpServer: x402HTTPResourceServer, flow: PaymentFlowName) {
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        payTo: "0xabc",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        extra: flow === "authorization" ? {} : { paymentFlow: flow },
      });
      const payload = buildPaymentPayload({
        accepted: requirements,
      });
      const adapter = new MockHTTPAdapter({
        "payment-signature": encodePaymentSignatureHeader(payload),
      });
      return httpServer.processHTTPRequest({
        adapter,
        path: "/api/test",
        method: "GET",
      });
    }

    it("authorization: verifies before handler and settles after with phase after-handler", async () => {
      const httpServer = await setup("authorization");
      const phases: SettlePhase[] = [];
      ResourceServer.onBeforeSettle(async ctx => {
        phases.push(ctx.phase);
      });

      const result = await verifiedRequest(httpServer, "authorization");
      expect(result.type).toBe("payment-verified");
      expect(mockFacilitator.verifyCalls).toHaveLength(1);
      expect(mockFacilitator.settleCalls).toHaveLength(0);

      if (result.type !== "payment-verified") return;
      const settle = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        undefined,
        undefined,
        result.beforeHandlerSettlement,
      );
      expect(settle.success).toBe(true);
      expect(mockFacilitator.settleCalls).toHaveLength(1);
      expect(phases).toEqual(["after-handler"]);
    });

    it("upfront: runs beforeVerify hooks, skips facilitator /verify, settles before handler", async () => {
      const httpServer = await setup("upfront");
      const phases: SettlePhase[] = [];
      let beforeVerifyRan = false;
      let afterVerifyRan = false;
      ResourceServer.onBeforeVerify(async () => {
        beforeVerifyRan = true;
      });
      ResourceServer.onAfterVerify(async () => {
        afterVerifyRan = true;
      });
      ResourceServer.onBeforeSettle(async ctx => {
        phases.push(ctx.phase);
      });

      const result = await verifiedRequest(httpServer, "upfront");
      expect(result.type).toBe("payment-verified");
      expect(beforeVerifyRan).toBe(true);
      expect(afterVerifyRan).toBe(false);
      expect(mockFacilitator.verifyCalls).toHaveLength(0);
      expect(mockFacilitator.settleCalls).toHaveLength(1);
      expect(phases).toEqual(["before-handler"]);

      if (result.type !== "payment-verified") return;
      expect(result.beforeHandlerSettlement?.phase).toBe("before-handler");
      // Wire payload must be SettleResponse only (no SDK-only headers/requirements)
      expect(result.beforeHandlerSettlement?.result).toEqual(
        expect.objectContaining({ success: true, transaction: "0xtx" }),
      );
      expect(result.beforeHandlerSettlement?.result).not.toHaveProperty("headers");
      expect(result.beforeHandlerSettlement?.result).not.toHaveProperty("requirements");

      const failureReceiptHeaders = httpServer.createCompletedSettlementHeaders(
        result.beforeHandlerSettlement!,
      );
      expect(failureReceiptHeaders["Cache-Control"]).toBe("private");
      expect(decodePaymentResponseHeader(failureReceiptHeaders["PAYMENT-RESPONSE"])).toEqual(
        expect.objectContaining({ success: true, transaction: "0xtx" }),
      );
      expect(
        decodePaymentResponseHeader(failureReceiptHeaders["PAYMENT-RESPONSE"]),
      ).not.toHaveProperty("headers");

      const settle = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        undefined,
        undefined,
        result.beforeHandlerSettlement,
      );
      expect(settle.success).toBe(true);
      if (settle.success) {
        expect(settle.headers["PAYMENT-RESPONSE"]).toBeDefined();
        expect(settle.transaction).toBe("0xtx");
      }
      expect(mockFacilitator.settleCalls).toHaveLength(1);
      expect(phases).toEqual(["before-handler"]);
    });

    it("upfront: beforeVerify abort returns payment-error and never settles", async () => {
      const httpServer = await setup("upfront");
      ResourceServer.onBeforeVerify(async () => {
        return { abort: true, reason: "extension_gate" };
      });

      const result = await verifiedRequest(httpServer, "upfront");
      expect(result.type).toBe("payment-error");
      expect(mockFacilitator.verifyCalls).toHaveLength(0);
      expect(mockFacilitator.settleCalls).toHaveLength(0);
    });

    it("escrow: settles before and after handler with distinct phases", async () => {
      const httpServer = await setup("escrow");
      const phases: SettlePhase[] = [];
      let beforeVerifyRan = false;
      ResourceServer.onBeforeVerify(async () => {
        beforeVerifyRan = true;
      });
      ResourceServer.onBeforeSettle(async ctx => {
        phases.push(ctx.phase);
      });

      const result = await verifiedRequest(httpServer, "escrow");
      expect(result.type).toBe("payment-verified");
      expect(beforeVerifyRan).toBe(true);
      expect(mockFacilitator.verifyCalls).toHaveLength(0);
      expect(mockFacilitator.settleCalls).toHaveLength(1);

      if (result.type !== "payment-verified") return;
      expect(result.beforeHandlerSettlement?.phase).toBe("before-handler");
      const settle = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        undefined,
        undefined,
        result.beforeHandlerSettlement,
      );
      expect(settle.success).toBe(true);
      expect(mockFacilitator.settleCalls).toHaveLength(2);
      expect(phases).toEqual(["before-handler", "after-handler"]);
    });

    it.each(["upfront", "escrow"] as const)(
      "%s: before-handler settle failure returns payment-error",
      async flow => {
        const httpServer = await setup(flow);
        mockFacilitator.setSettleResponse(
          buildSettleResponse({
            success: false,
            errorReason: "insufficient_funds",
            transaction: "",
          }),
        );

        const result = await verifiedRequest(httpServer, flow);
        expect(result.type).toBe("payment-error");
        expect(mockFacilitator.verifyCalls).toHaveLength(0);
        expect(mockFacilitator.settleCalls).toHaveLength(1);
        if (result.type !== "payment-error") return;
        expect(result.response.status).toBe(402);
      },
    );

    it("escrow: cancel after before-handler settle returns refund receipt", async () => {
      const httpServer = await setup("escrow");
      mockFacilitator.setSettleResponse(
        buildSettleResponse({ success: true, transaction: "0xdeposit" }),
      );

      const escrowScheme = schemeWithFlow("escrow");
      escrowScheme.settleOnCancel = async context => ({ ...context.requirements, amount: "0" });
      ResourceServer.register("eip155:8453" as Network, escrowScheme);

      let settledPhases: readonly SettlePhase[] | undefined;
      ResourceServer.onVerifiedPaymentCanceled(async ctx => {
        settledPhases = ctx.settledPhases;
        expect(ctx.phase).toBe("cancel");
        expect(ctx.reason).toBe("handler_failed");
      });

      const result = await verifiedRequest(httpServer, "escrow");
      expect(result.type).toBe("payment-verified");
      if (result.type !== "payment-verified") return;

      expect(result.beforeHandlerSettlement?.phase).toBe("before-handler");
      expect(result.beforeHandlerSettlement?.result.transaction).toBe("0xdeposit");
      expect(mockFacilitator.settleCalls).toHaveLength(1);

      mockFacilitator.setSettleResponse(
        buildSettleResponse({ success: true, amount: "0", transaction: "0xrefund" }),
      );

      const cancelResult = await result.cancellationDispatcher.cancel({
        reason: "handler_failed",
        responseStatus: 500,
      });
      expect(settledPhases).toEqual(["before-handler"]);
      expect(mockFacilitator.settleCalls).toHaveLength(2);
      expect(cancelResult).toEqual(
        expect.objectContaining({
          success: true,
          amount: "0",
          transaction: "0xrefund",
        }),
      );

      const receiptHeaders = httpServer.createFailurePathSettlementHeaders(
        cancelResult,
        result.beforeHandlerSettlement,
        result.paymentPayload,
      );
      expect(decodePaymentResponseHeader(receiptHeaders!["PAYMENT-RESPONSE"])).toEqual(
        expect.objectContaining({ success: true, amount: "0", transaction: "0xrefund" }),
      );
    });

    it("builds failed cancel receipt with deposit recovery extra", async () => {
      const httpServer = await setup("escrow");
      const cancelSettlement = {
        success: false,
        errorReason: "refund_failed",
        transaction: "should-not-appear",
        network: "eip155:8453" as Network,
      };
      const beforeHandlerSettlement = {
        phase: "before-handler" as const,
        flow: "escrow" as const,
        result: {
          success: true,
          amount: "100000",
          transaction: "0xdeposit",
          network: "eip155:8453" as Network,
        },
        requirements: buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
        }),
      };
      const paymentPayload = buildPaymentPayload({
        payload: { channelId: "channel-123" },
      });

      const receiptHeaders = httpServer.createFailurePathSettlementHeaders(
        cancelSettlement,
        beforeHandlerSettlement,
        paymentPayload,
      );
      const decoded = decodePaymentResponseHeader(receiptHeaders!["PAYMENT-RESPONSE"]);
      expect(decoded.success).toBe(false);
      expect(decoded.transaction).toBe("");
      expect(decoded.amount).toBeUndefined();
      expect(decoded.extra).toEqual(
        expect.objectContaining({
          depositTransaction: "0xdeposit",
          depositAmount: "100000",
          channelId: "channel-123",
        }),
      );
    });

    it("warns once when settleBeforeHandler flow is settled without beforeHandlerSettlement", async () => {
      const httpServer = await setup("upfront");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const result = await verifiedRequest(httpServer, "upfront");
      expect(result.type).toBe("payment-verified");
      if (result.type !== "payment-verified") return;

      // Drop beforeHandlerSettlement: adapters that have not been updated yet.
      const settle1 = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
      );
      const settle2 = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
      );

      expect(settle1.success).toBe(true);
      expect(settle2.success).toBe(true);
      if (settle1.success) {
        expect(settle1.headers).toEqual({});
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("without beforeHandlerSettlement");
    });
  });
});
