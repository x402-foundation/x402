import { beforeEach, describe, expect, it } from "vitest";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  HTTPAdapter,
  HTTPResponseInstructions,
  x402HTTPResourceServer,
  x402ResourceServer,
  FacilitatorClient,
} from "@x402/core/server";
import {
  Network,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  SupportedResponse,
} from "@x402/core/types";
import {
  ExactAvmScheme as ExactAvmClient,
  ALGORAND_TESTNET_CAIP2,
  USDC_TESTNET_ASA_ID,
  toClientAvmSigner,
  toFacilitatorAvmSigner,
} from "../../src";
import { ExactAvmScheme as ExactAvmServer } from "../../src/exact/server/scheme";
import { ExactAvmScheme as ExactAvmFacilitator } from "../../src/exact/facilitator/scheme";
import type { ExactAvmPayloadV2 } from "../../src/types";

// Load private keys from environment (Base64-encoded 64-byte keys)
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY;
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY;
// Server address (payTo) — must be opt-in to USDC.
const SERVER_ADDRESS = process.env.SERVER_ADDRESS;

if (!CLIENT_PRIVATE_KEY || !FACILITATOR_PRIVATE_KEY || !SERVER_ADDRESS) {
  throw new Error(
    "CLIENT_PRIVATE_KEY, FACILITATOR_PRIVATE_KEY, and SERVER_ADDRESS environment variables must be set for integration tests",
  );
}

// Create signers using helper functions
const clientSigner = toClientAvmSigner(CLIENT_PRIVATE_KEY);
const facilitatorSigner = toFacilitatorAvmSigner(FACILITATOR_PRIVATE_KEY);
const FACILITATOR_ADDRESS = facilitatorSigner.getAddresses()[0];

/**
 * AVM Facilitator Client wrapper
 * Wraps the x402Facilitator for use with x402ResourceServer
 */
class AvmFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = ALGORAND_TESTNET_CAIP2;
  readonly x402Version = 2;

  /**
   * Creates a new AvmFacilitatorClient instance
   *
   * @param facilitator - The x402 facilitator to wrap
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * Verifies a payment payload
   *
   * @param paymentPayload - The payment payload to verify
   * @param paymentRequirements - The payment requirements
   * @returns Promise resolving to verification response
   */
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  /**
   * Settles a payment
   *
   * @param paymentPayload - The payment payload to settle
   * @param paymentRequirements - The payment requirements
   * @returns Promise resolving to settlement response
   */
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  /**
   * Gets supported payment kinds
   *
   * @returns Promise resolving to supported response
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported());
  }
}

/**
 * Build AVM payment requirements for testing
 *
 * @param payTo - The recipient address
 * @param amount - The payment amount in smallest units
 * @param network - The network identifier (defaults to Algorand Testnet)
 * @returns Payment requirements object
 */
function buildAvmPaymentRequirements(
  payTo: string,
  amount: string,
  network: Network = ALGORAND_TESTNET_CAIP2,
): PaymentRequirements {
  return {
    scheme: "exact",
    network,
    asset: USDC_TESTNET_ASA_ID, // Algorand Testnet USDC
    amount,
    payTo,
    maxTimeoutSeconds: 3600,
    extra: {
      feePayer: FACILITATOR_ADDRESS,
    },
  };
}

describe("AVM Integration Tests", () => {
  describe("x402Client / x402ResourceServer / x402Facilitator - AVM Flow", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let clientAddress: string;

    beforeEach(async () => {
      clientAddress = clientSigner.address;

      const avmClient = new ExactAvmClient(clientSigner);
      client = new x402Client().register(ALGORAND_TESTNET_CAIP2, avmClient);

      const avmFacilitator = new ExactAvmFacilitator(facilitatorSigner);
      const facilitator = new x402Facilitator().register(ALGORAND_TESTNET_CAIP2, avmFacilitator);

      const facilitatorClient = new AvmFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);
      server.register(ALGORAND_TESTNET_CAIP2, new ExactAvmServer());
      await server.initialize();
    });

    it(
      "server should successfully verify and settle an AVM payment from a client",
      { timeout: 30000 },
      async () => {
        // Server - builds PaymentRequired response
        const accepts = [
          buildAvmPaymentRequirements(
            SERVER_ADDRESS,
            "1000", // 0.001 USDC
          ),
        ];
        const resource = {
          url: "https://company.co",
          description: "Company Co. resource",
          mimeType: "application/json",
        };
        const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

        // Client - responds with PaymentPayload response
        const paymentPayload = await client.createPaymentPayload(paymentRequired);

        expect(paymentPayload).toBeDefined();
        expect(paymentPayload.x402Version).toBe(2);
        expect(paymentPayload.accepted.scheme).toBe("exact");

        // Verify the payload structure
        const avmPayload = paymentPayload.payload as ExactAvmPayloadV2;
        expect(avmPayload.paymentGroup).toBeDefined();
        expect(avmPayload.paymentGroup.length).toBeGreaterThan(0);
        expect(typeof avmPayload.paymentGroup[0]).toBe("string");
        expect(avmPayload.paymentGroup[0].length).toBeGreaterThan(0);

        // Server - maps payment payload to payment requirements
        const accepted = server.findMatchingRequirements(accepts, paymentPayload);
        expect(accepted).toBeDefined();

        const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);

        if (!verifyResponse.isValid) {
          console.log("❌ Verification failed!");
          console.log("Invalid reason:", verifyResponse.invalidReason);
          console.log("Payer:", verifyResponse.payer);
          console.log("Client address:", clientAddress);
          console.log("Payload:", JSON.stringify(paymentPayload, null, 2));
        }

        expect(verifyResponse.isValid).toBe(true);
        expect(verifyResponse.payer).toBe(clientAddress);

        // Server does work here

        const settleResponse = await server.settlePayment(paymentPayload, accepted!);

        if (!settleResponse.success) {
          console.log("❌ Direct Settlement failed!", JSON.stringify(settleResponse, null, 2));
        }

        expect(settleResponse.success).toBe(true);
        expect(settleResponse.network).toBe(ALGORAND_TESTNET_CAIP2);
        expect(settleResponse.transaction).toBeDefined();
        expect(settleResponse.payer).toBe(clientAddress);
      },
    );
  });

  describe("x402HTTPClient / x402HTTPResourceServer / x402Facilitator - AVM Flow", () => {
    let client: x402HTTPClient;
    let httpServer: x402HTTPResourceServer;

    const routes = {
      "/api/protected": {
        accepts: {
          scheme: "exact",
          payTo: SERVER_ADDRESS,
          price: "$0.001",
          network: ALGORAND_TESTNET_CAIP2 as Network,
        },
        description: "Access to protected API",
        mimeType: "application/json",
      },
    };

    const mockAdapter: HTTPAdapter = {
      getHeader: () => {
        return undefined;
      },
      getMethod: () => "GET",
      getPath: () => "/api/protected",
      getUrl: () => "https://example.com/api/protected",
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "TestClient/1.0",
    };

    beforeEach(async () => {
      // Brief pause to avoid rate limiting on free public algod nodes
      // (the previous test suite makes multiple algod calls)
      await new Promise(resolve => setTimeout(resolve, 3000));

      const avmFacilitator = new ExactAvmFacilitator(facilitatorSigner);
      const facilitator = new x402Facilitator().register(ALGORAND_TESTNET_CAIP2, avmFacilitator);

      const facilitatorClient = new AvmFacilitatorClient(facilitator);

      const avmClient = new ExactAvmClient(clientSigner);
      const paymentClient = new x402Client().register(ALGORAND_TESTNET_CAIP2, avmClient);
      client = new x402HTTPClient(paymentClient) as x402HTTPClient;

      // Create resource server and register schemes (composition pattern)
      const ResourceServer = new x402ResourceServer(facilitatorClient);
      ResourceServer.register(ALGORAND_TESTNET_CAIP2, new ExactAvmServer());
      await ResourceServer.initialize(); // Initialize to fetch supported kinds

      httpServer = new x402HTTPResourceServer(ResourceServer, routes);
    });

    it(
      "middleware should successfully verify and settle an AVM payment from an http client",
      { timeout: 30000 },
      async () => {
        // Middleware creates a PaymentRequired response
        const context = {
          adapter: mockAdapter,
          path: "/api/protected",
          method: "GET",
        };

        // No payment made, get PaymentRequired response & header
        const httpProcessResult = (await httpServer.processHTTPRequest(context))!;

        expect(httpProcessResult.type).toBe("payment-error");

        const initial402Response = (
          httpProcessResult as { type: "payment-error"; response: HTTPResponseInstructions }
        ).response;

        expect(initial402Response).toBeDefined();
        expect(initial402Response.status).toBe(402);
        expect(initial402Response.headers).toBeDefined();
        expect(initial402Response.headers["PAYMENT-REQUIRED"]).toBeDefined();

        // Client responds to PaymentRequired and submits a request with a PaymentPayload
        const paymentRequired = client.getPaymentRequiredResponse(
          name => initial402Response.headers[name],
          initial402Response.body,
        );
        const paymentPayload = await client.createPaymentPayload(paymentRequired);

        expect(paymentPayload).toBeDefined();
        expect(paymentPayload.accepted.scheme).toBe("exact");

        const requestHeaders = await client.encodePaymentSignatureHeader(paymentPayload);

        // Middleware handles PAYMENT-SIGNATURE request
        mockAdapter.getHeader = (name: string) => {
          if (name === "PAYMENT-SIGNATURE") {
            return requestHeaders["PAYMENT-SIGNATURE"];
          }
          return undefined;
        };

        const httpProcessResult2 = await httpServer.processHTTPRequest(context);

        // No need to respond, can continue with request
        expect(httpProcessResult2.type).toBe("payment-verified");
        const {
          paymentPayload: verifiedPaymentPayload,
          paymentRequirements: verifiedPaymentRequirements,
        } = httpProcessResult2 as {
          type: "payment-verified";
          paymentPayload: PaymentPayload;
          paymentRequirements: PaymentRequirements;
        };

        expect(verifiedPaymentPayload).toBeDefined();
        expect(verifiedPaymentRequirements).toBeDefined();

        const settlementResult = await httpServer.processSettlement(
          verifiedPaymentPayload,
          verifiedPaymentRequirements,
          200,
        );

        expect(settlementResult).toBeDefined();

        if (!settlementResult.success) {
          console.log("❌ HTTP Settlement failed!", JSON.stringify(settlementResult, null, 2));
        }

        expect(settlementResult.success).toBe(true);

        if (settlementResult.success) {
          expect(settlementResult.headers).toBeDefined();
          expect(settlementResult.headers["PAYMENT-RESPONSE"]).toBeDefined();
        }
      },
    );
  });

  describe("Price Parsing Integration", () => {
    let server: x402ResourceServer;
    let avmServer: ExactAvmServer;

    beforeEach(async () => {
      const facilitator = new x402Facilitator().register(
        ALGORAND_TESTNET_CAIP2,
        new ExactAvmFacilitator(facilitatorSigner),
      );

      const facilitatorClient = new AvmFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);

      avmServer = new ExactAvmServer();
      server.register(ALGORAND_TESTNET_CAIP2, avmServer);
      await server.initialize();
    });

    it("should parse Money formats and build payment requirements", async () => {
      // Test different Money formats
      const testCases = [
        { input: "$1.00", expectedAmount: "1000000" },
        { input: "1.50", expectedAmount: "1500000" },
        { input: 2.5, expectedAmount: "2500000" },
      ];

      for (const testCase of testCases) {
        const requirements = await server.buildPaymentRequirements({
          scheme: "exact",
          payTo: SERVER_ADDRESS,
          price: testCase.input,
          network: ALGORAND_TESTNET_CAIP2 as Network,
        });

        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(testCase.expectedAmount);
        expect(requirements[0].asset).toBe(USDC_TESTNET_ASA_ID); // Algorand Testnet USDC
      }
    });

    it("should handle AssetAmount pass-through", async () => {
      const customAsset = {
        amount: "5000000",
        asset: "12345678",
        extra: { foo: "bar" },
      };

      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: SERVER_ADDRESS,
        price: customAsset,
        network: ALGORAND_TESTNET_CAIP2 as Network,
      });

      expect(requirements).toHaveLength(1);
      expect(requirements[0].amount).toBe("5000000");
      expect(requirements[0].asset).toBe("12345678");
      expect(requirements[0].extra?.foo).toBe("bar");
    });

    it("should use registerMoneyParser for custom conversion", async () => {
      // Register custom parser: large amounts use custom token
      avmServer.registerMoneyParser(async (amount, _network) => {
        if (amount > 100) {
          return {
            amount: (amount * 1e6).toString(), // Custom token with 6 decimals
            asset: "99999999",
            extra: { token: "CUSTOM", tier: "large" },
          };
        }
        return null; // Use default for small amounts
      });

      // Test large amount - should use custom parser
      const largeRequirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: SERVER_ADDRESS,
        price: 150, // Large amount
        network: ALGORAND_TESTNET_CAIP2 as Network,
      });

      expect(largeRequirements[0].amount).toBe((150 * 1e6).toString());
      expect(largeRequirements[0].asset).toBe("99999999");
      expect(largeRequirements[0].extra?.token).toBe("CUSTOM");
      expect(largeRequirements[0].extra?.tier).toBe("large");

      // Test small amount - should use default USDC
      const smallRequirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: SERVER_ADDRESS,
        price: 50, // Small amount
        network: ALGORAND_TESTNET_CAIP2 as Network,
      });

      expect(smallRequirements[0].amount).toBe("50000000"); // 50 * 1e6 (USDC)
      expect(smallRequirements[0].asset).toBe(USDC_TESTNET_ASA_ID); // Algorand Testnet USDC
    });

    it("should support multiple MoneyParser in chain", async () => {
      avmServer
        .registerMoneyParser(async amount => {
          if (amount > 1000) {
            return {
              amount: (amount * 1e6).toString(),
              asset: "88888888",
              extra: { tier: "vip" },
            };
          }
          return null;
        })
        .registerMoneyParser(async amount => {
          if (amount > 100) {
            return {
              amount: (amount * 1e6).toString(),
              asset: "77777777",
              extra: { tier: "premium" },
            };
          }
          return null;
        });
      // < 100 uses default USDC

      // VIP tier
      const vipReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: SERVER_ADDRESS,
        price: 2000,
        network: ALGORAND_TESTNET_CAIP2 as Network,
      });
      expect(vipReq[0].extra?.tier).toBe("vip");
      expect(vipReq[0].asset).toBe("88888888");

      // Premium tier
      const premiumReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: SERVER_ADDRESS,
        price: 500,
        network: ALGORAND_TESTNET_CAIP2 as Network,
      });
      expect(premiumReq[0].extra?.tier).toBe("premium");
      expect(premiumReq[0].asset).toBe("77777777");

      // Standard tier (default)
      const standardReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: SERVER_ADDRESS,
        price: 50,
        network: ALGORAND_TESTNET_CAIP2 as Network,
      });
      expect(standardReq[0].asset).toBe(USDC_TESTNET_ASA_ID); // Default USDC
    });

    it("should work with async MoneyParser (e.g., exchange rate lookup)", async () => {
      const mockExchangeRate = 1.02;

      avmServer.registerMoneyParser(async (amount, _network) => {
        // Simulate async API call
        await new Promise(resolve => setTimeout(resolve, 10));

        const usdcAmount = amount * mockExchangeRate;
        return {
          amount: Math.floor(usdcAmount * 1e6).toString(),
          asset: USDC_TESTNET_ASA_ID,
          extra: {
            exchangeRate: mockExchangeRate,
            originalUSD: amount,
          },
        };
      });

      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: SERVER_ADDRESS,
        price: 100,
        network: ALGORAND_TESTNET_CAIP2 as Network,
      });

      // 100 USD * 1.02 = 102 USDC
      expect(requirements[0].amount).toBe("102000000");
      expect(requirements[0].extra?.exchangeRate).toBe(1.02);
      expect(requirements[0].extra?.originalUSD).toBe(100);
    });

    it("should avoid floating-point rounding error", async () => {
      // Test different Money formats
      const testCases = [
        { input: "$4.02", expectedAmount: "4020000" },
        { input: "4.02", expectedAmount: "4020000" },
        { input: "4.02 USDC", expectedAmount: "4020000" },
        { input: "4.02 USD", expectedAmount: "4020000" },
        { input: 4.02, expectedAmount: "4020000" },
      ];

      for (const testCase of testCases) {
        const requirements = await server.buildPaymentRequirements({
          scheme: "exact",
          payTo: SERVER_ADDRESS,
          price: testCase.input,
          network: ALGORAND_TESTNET_CAIP2 as Network,
        });

        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(testCase.expectedAmount);
        expect(requirements[0].asset).toBe(USDC_TESTNET_ASA_ID); // Algorand Testnet USDC
      }
    });
  });
});
