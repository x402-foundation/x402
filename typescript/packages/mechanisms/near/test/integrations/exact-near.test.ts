import { x402Client, x402HTTPClient } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPResponseInstructions,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ASSET_BY_NETWORK } from "../../src/constants";
import { ExactNearScheme as ExactNearClient } from "../../src/exact/client";
import { ExactNearScheme as ExactNearFacilitator } from "../../src/exact/facilitator";
import { ExactNearScheme as ExactNearServer } from "../../src/exact/server";
import type { ExactNearPayload } from "../../src/types";
import {
  FIXTURE,
  buildSignedDelegateB64,
  mockFacilitatorSigner,
} from "../unit/fixtures/near.fixture";

class NearFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = FIXTURE.network;
  readonly x402Version = 2;

  constructor(private readonly facilitator: x402Facilitator) {}

  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported());
  }
}

const resource = {
  url: "https://company.co",
  description: "Company Co. resource",
  mimeType: "application/json",
};

function buildNearPaymentRequirements(
  payTo: string,
  asset: string,
  amount: string,
  network: Network = FIXTURE.network,
): PaymentRequirements {
  return {
    scheme: "exact",
    network,
    asset,
    amount,
    payTo,
    maxTimeoutSeconds: FIXTURE.maxTimeoutSeconds,
    extra: {},
  };
}

const buildClient = (): x402Client =>
  new x402Client().register(
    FIXTURE.network,
    new ExactNearClient({
      async createSignedDelegateAction({ paymentRequirements }) {
        const { b64 } = await buildSignedDelegateB64({
          amount: paymentRequirements.amount,
          ftReceiver: paymentRequirements.payTo,
          maxBlockHeight: FIXTURE.maxBlockHeight,
          nonce: FIXTURE.nonce,
          receiverId: paymentRequirements.asset,
          senderId: FIXTURE.senderId,
        });
        return b64;
      },
    }),
  );

const buildResourceServer = async (
  nearServer: ExactNearServer = new ExactNearServer(),
): Promise<x402ResourceServer> => {
  const facilitator = new x402Facilitator().register(
    FIXTURE.network,
    new ExactNearFacilitator(mockFacilitatorSigner()),
  );
  const server = new x402ResourceServer(new NearFacilitatorClient(facilitator));
  server.register(FIXTURE.network, nearServer);
  await server.initialize();
  return server;
};

describe("NEAR Integration Tests", () => {
  describe("x402Client / x402ResourceServer / x402Facilitator - NEAR Flow", () => {
    let client: x402Client;
    let server: x402ResourceServer;

    beforeEach(async () => {
      client = buildClient();
      server = await buildResourceServer();
    });

    it("server should successfully verify and settle a NEAR payment from a client", async () => {
      const accepts = [buildNearPaymentRequirements(FIXTURE.payTo, FIXTURE.asset, FIXTURE.amount)];
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      expect(paymentPayload.x402Version).toBe(2);
      expect(paymentPayload.accepted.scheme).toBe("exact");
      expect(paymentPayload.accepted.network).toBe(FIXTURE.network);
      expect(paymentPayload.accepted.extra?.relayerId).toBeUndefined();

      const nearPayload = paymentPayload.payload as ExactNearPayload;
      expect(typeof nearPayload.signedDelegateAction).toBe("string");
      expect(nearPayload.signedDelegateAction.length).toBeGreaterThan(0);

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);
      expect(verifyResponse.payer).toBe(FIXTURE.senderId);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.network).toBe(FIXTURE.network);
      expect(settleResponse.transaction).toBe("FIXTURETX");
      expect(settleResponse.payer).toBe(FIXTURE.senderId);
    });
  });

  describe("x402HTTPClient / x402HTTPResourceServer / x402Facilitator - NEAR Flow", () => {
    let client: x402HTTPClient;
    let httpServer: x402HTTPResourceServer;

    const routes = {
      "/api/protected": {
        accepts: {
          scheme: "exact",
          payTo: FIXTURE.payTo,
          price: { amount: FIXTURE.amount, asset: FIXTURE.asset },
          network: FIXTURE.network as Network,
          maxTimeoutSeconds: FIXTURE.maxTimeoutSeconds,
        },
        description: "Access to protected API",
        mimeType: "application/json",
      },
    };

    const mockAdapter: HTTPAdapter = {
      getAcceptHeader: () => "application/json",
      getHeader: () => undefined,
      getMethod: () => "GET",
      getPath: () => "/api/protected",
      getUrl: () => "https://example.com/api/protected",
      getUserAgent: () => "TestClient/1.0",
    };

    beforeEach(async () => {
      const paymentClient = buildClient();
      client = new x402HTTPClient(paymentClient);
      httpServer = new x402HTTPResourceServer(await buildResourceServer(), routes);
    });

    it("middleware should successfully verify and settle a NEAR payment from an http client", async () => {
      const context = {
        adapter: mockAdapter,
        method: "GET",
        path: "/api/protected",
      };

      const firstResult = await httpServer.processHTTPRequest(context);
      expect(firstResult.type).toBe("payment-error");

      const initialResponse = (
        firstResult as { type: "payment-error"; response: HTTPResponseInstructions }
      ).response;
      expect(initialResponse.status).toBe(402);
      expect(initialResponse.headers["PAYMENT-REQUIRED"]).toBeDefined();

      const paymentRequired = client.getPaymentRequiredResponse(
        name => initialResponse.headers[name],
        initialResponse.body,
      );
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const requestHeaders = await client.encodePaymentSignatureHeader(paymentPayload);

      mockAdapter.getHeader = (name: string) => {
        if (name === "PAYMENT-SIGNATURE") {
          return requestHeaders["PAYMENT-SIGNATURE"];
        }
        return undefined;
      };

      const secondResult = await httpServer.processHTTPRequest(context);
      expect(secondResult.type).toBe("payment-verified");

      const verified = secondResult as {
        type: "payment-verified";
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };
      expect(verified.paymentPayload.accepted.network).toBe(FIXTURE.network);
      expect(verified.paymentRequirements.asset).toBe(FIXTURE.asset);

      const settlementResult = await httpServer.processSettlement(
        verified.paymentPayload,
        verified.paymentRequirements,
        200,
      );
      expect(settlementResult.success).toBe(true);
      expect(settlementResult.headers?.["PAYMENT-RESPONSE"]).toBeDefined();
    });
  });

  describe("Price Parsing Integration", () => {
    let server: x402ResourceServer;
    let nearServer: ExactNearServer;

    beforeEach(async () => {
      nearServer = new ExactNearServer();
      server = await buildResourceServer(nearServer);
    });

    it("should parse Money formats and build payment requirements", async () => {
      const testCases = [
        { input: "$1.00", expectedAmount: "1000000" },
        { input: "1.50", expectedAmount: "1500000" },
        { input: 2.5, expectedAmount: "2500000" },
        { input: "$4.02", expectedAmount: "4020000" },
      ];

      for (const testCase of testCases) {
        const requirements = await server.buildPaymentRequirements({
          scheme: "exact",
          payTo: FIXTURE.payTo,
          price: testCase.input,
          network: FIXTURE.network as Network,
        });

        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(testCase.expectedAmount);
        expect(requirements[0].asset).toBe(DEFAULT_ASSET_BY_NETWORK[FIXTURE.network]);
      }
    });

    it("should handle AssetAmount pass-through", async () => {
      const customAsset = {
        amount: "5000000",
        asset: FIXTURE.asset,
        extra: { external: "abc123" },
      };

      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: FIXTURE.payTo,
        price: customAsset,
        network: FIXTURE.network as Network,
      });

      expect(requirements).toHaveLength(1);
      expect(requirements[0].amount).toBe("5000000");
      expect(requirements[0].asset).toBe(FIXTURE.asset);
      expect(requirements[0].extra?.external).toBe("abc123");
    });

    it("should use registerMoneyParser for custom conversion", async () => {
      nearServer.registerMoneyParser(async (amount, _network) => {
        if (amount > 100) {
          return {
            amount: String(Math.round(amount * 1e8)),
            asset: "premium-usdc.testnet",
            extra: { tier: "large" },
          };
        }
        return null;
      });

      const largeRequirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: FIXTURE.payTo,
        price: 150,
        network: FIXTURE.network as Network,
      });
      expect(largeRequirements[0].amount).toBe(String(Math.round(150 * 1e8)));
      expect(largeRequirements[0].asset).toBe("premium-usdc.testnet");
      expect(largeRequirements[0].extra?.tier).toBe("large");

      const smallRequirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: FIXTURE.payTo,
        price: 50,
        network: FIXTURE.network as Network,
      });
      expect(smallRequirements[0].amount).toBe("50000000");
      expect(smallRequirements[0].asset).toBe(DEFAULT_ASSET_BY_NETWORK[FIXTURE.network]);
    });
  });
});
