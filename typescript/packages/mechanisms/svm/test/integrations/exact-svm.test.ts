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
import { ExactSvmScheme as ExactSvmClient, toFacilitatorSvmSigner } from "../../src";
import { ExactSvmScheme as ExactSvmServer } from "../../src/exact/server/scheme";
import { ExactSvmScheme as ExactSvmFacilitator } from "../../src/exact/facilitator/scheme";
import type { ExactSvmPayloadV2 } from "../../src/types";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

// Load private keys and addresses from environment
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY;
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY;
const FACILITATOR_ADDRESS = process.env.FACILITATOR_ADDRESS;
const RESOURCE_SERVER_ADDRESS = process.env.RESOURCE_SERVER_ADDRESS;

if (
  !CLIENT_PRIVATE_KEY ||
  !FACILITATOR_PRIVATE_KEY ||
  !FACILITATOR_ADDRESS ||
  !RESOURCE_SERVER_ADDRESS
) {
  throw new Error(
    "CLIENT_PRIVATE_KEY, FACILITATOR_PRIVATE_KEY, FACILITATOR_ADDRESS and RESOURCE_SERVER_ADDRESS environment variables must be set for integration tests",
  );
}

/**
 * SVM Facilitator Client wrapper
 * Wraps the x402Facilitator for use with x402ResourceServer
 */
class SvmFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // Solana Devnet
  readonly x402Version = 2;

  /**
   * Creates a new SvmFacilitatorClient instance
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
    // Delegate to actual facilitator to get real supported kinds
    // This includes dynamically selected feePayer addresses
    return Promise.resolve(this.facilitator.getSupported());
  }
}

/**
 * Build SVM payment requirements for testing
 *
 * @param payTo - The recipient address
 * @param amount - The payment amount in smallest units
 * @param network - The network identifier (defaults to Solana Devnet)
 * @returns Payment requirements object
 */
function buildSvmPaymentRequirements(
  payTo: string,
  amount: string,
  network: Network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
): PaymentRequirements {
  return {
    scheme: "exact",
    network,
    asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Devnet USDC
    amount,
    payTo,
    maxTimeoutSeconds: 3600,
    extra: {
      feePayer: FACILITATOR_ADDRESS,
    },
  };
}

describe("SVM Integration Tests", () => {
  describe("x402Client / x402ResourceServer / x402Facilitator - SVM Flow", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let clientAddress: string;

    beforeEach(async () => {
      const clientBytes = base58.decode(CLIENT_PRIVATE_KEY);
      const clientSigner = await createKeyPairSignerFromBytes(clientBytes);
      clientAddress = clientSigner.address;

      const svmClient = new ExactSvmClient(clientSigner, {
        rpcUrl: "https://api.devnet.solana.com",
      });
      client = new x402Client().register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", svmClient);

      const facilitatorBytes = base58.decode(FACILITATOR_PRIVATE_KEY);
      const facilitatorKeypair = await createKeyPairSignerFromBytes(facilitatorBytes);
      const facilitatorSigner = toFacilitatorSvmSigner(facilitatorKeypair);

      const svmFacilitator = new ExactSvmFacilitator(facilitatorSigner);
      const facilitator = new x402Facilitator().register(
        "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        svmFacilitator,
      );

      const facilitatorClient = new SvmFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);
      server.register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmServer());
      await server.initialize();
    });

    it("server should successfully verify and settle a SVM payment from a client", async () => {
      const accepts = [buildSvmPaymentRequirements(RESOURCE_SERVER_ADDRESS, "1000")];
      const resource = {
        url: "https://company.co",
        description: "Company Co. resource",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      expect(paymentPayload).toBeDefined();
      expect(paymentPayload.x402Version).toBe(2);
      expect(paymentPayload.accepted.scheme).toBe("exact");

      const svmPayload = paymentPayload.payload as ExactSvmPayloadV2;
      expect(svmPayload.transaction).toBeDefined();
      expect(typeof svmPayload.transaction).toBe("string");
      expect(svmPayload.transaction.length).toBeGreaterThan(0);

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);

      expect(verifyResponse.isValid).toBe(true);
      expect(verifyResponse.payer).toBe(clientAddress);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
      expect(settleResponse.transaction).toBeDefined();
      expect(settleResponse.payer).toBe(clientAddress);
    });
  });

  describe("x402HTTPClient / x402HTTPResourceServer / x402Facilitator - SVM Flow", () => {
    let client: x402HTTPClient;
    let httpServer: x402HTTPResourceServer;

    const routes = {
      "/api/protected": {
        accepts: {
          scheme: "exact",
          payTo: RESOURCE_SERVER_ADDRESS,
          price: "$0.001",
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network,
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
      const facilitatorBytes = base58.decode(FACILITATOR_PRIVATE_KEY);
      const facilitatorKeypair = await createKeyPairSignerFromBytes(facilitatorBytes);
      const facilitatorSigner = toFacilitatorSvmSigner(facilitatorKeypair);

      const svmFacilitator = new ExactSvmFacilitator(facilitatorSigner);
      const facilitator = new x402Facilitator().register(
        "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        svmFacilitator,
      );

      const facilitatorClient = new SvmFacilitatorClient(facilitator);

      const clientBytes = base58.decode(CLIENT_PRIVATE_KEY);
      const clientSigner = await createKeyPairSignerFromBytes(clientBytes);

      const svmClient = new ExactSvmClient(clientSigner, {
        rpcUrl: "https://api.devnet.solana.com",
      });
      const paymentClient = new x402Client().register(
        "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        svmClient,
      );
      client = new x402HTTPClient(paymentClient) as x402HTTPClient;

      // Create resource server and register schemes (composition pattern)
      const ResourceServer = new x402ResourceServer(facilitatorClient);
      ResourceServer.register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmServer());
      await ResourceServer.initialize(); // Initialize to fetch supported kinds

      httpServer = new x402HTTPResourceServer(ResourceServer, routes);
    });

    it("middleware should successfully verify and settle a SVM payment from an http client", async () => {
      const context = {
        adapter: mockAdapter,
        path: "/api/protected",
        method: "GET",
      };

      const httpProcessResult = (await httpServer.processHTTPRequest(context))!;
      expect(httpProcessResult.type).toBe("payment-error");

      const initial402Response = (
        httpProcessResult as { type: "payment-error"; response: HTTPResponseInstructions }
      ).response;

      expect(initial402Response).toBeDefined();
      expect(initial402Response.status).toBe(402);
      expect(initial402Response.headers).toBeDefined();
      expect(initial402Response.headers["PAYMENT-REQUIRED"]).toBeDefined();

      const paymentRequired = client.getPaymentRequiredResponse(
        name => initial402Response.headers[name],
        initial402Response.body,
      );
      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      expect(paymentPayload).toBeDefined();
      expect(paymentPayload.accepted.scheme).toBe("exact");

      const requestHeaders = await client.encodePaymentSignatureHeader(paymentPayload);

      mockAdapter.getHeader = (name: string) => {
        if (name === "PAYMENT-SIGNATURE") {
          return requestHeaders["PAYMENT-SIGNATURE"];
        }
        return undefined;
      };

      const httpProcessResult2 = await httpServer.processHTTPRequest(context);

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
      expect(settlementResult.success).toBe(true);

      if (settlementResult.success) {
        expect(settlementResult.headers).toBeDefined();
        expect(settlementResult.headers["PAYMENT-RESPONSE"]).toBeDefined();
      }
    });
  });

  describe("Price Parsing Integration", () => {
    let server: x402ResourceServer;
    let svmServer: ExactSvmServer;

    beforeEach(async () => {
      const facilitatorBytes = base58.decode(FACILITATOR_PRIVATE_KEY);
      const facilitatorSigner = await createKeyPairSignerFromBytes(facilitatorBytes);

      const facilitatorSvmSigner = toFacilitatorSvmSigner(facilitatorSigner, {
        defaultRpcUrl: "https://api.devnet.solana.com",
      });

      const facilitator = new x402Facilitator().register(
        "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        new ExactSvmFacilitator(facilitatorSvmSigner),
      );

      const facilitatorClient = new SvmFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);

      svmServer = new ExactSvmServer();
      server.register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", svmServer);
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
          payTo: RESOURCE_SERVER_ADDRESS,
          price: testCase.input,
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network,
        });

        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(testCase.expectedAmount);
        expect(requirements[0].asset).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // Devnet USDC
      }
    });

    it("should handle AssetAmount pass-through", async () => {
      const customAsset = {
        amount: "5000000",
        asset: "CustomTokenMint1111111111111111111111",
        extra: { foo: "bar" },
      };

      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: RESOURCE_SERVER_ADDRESS,
        price: customAsset,
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network,
      });

      expect(requirements).toHaveLength(1);
      expect(requirements[0].amount).toBe("5000000");
      expect(requirements[0].asset).toBe("CustomTokenMint1111111111111111111111");
      expect(requirements[0].extra?.foo).toBe("bar");
    });

    it("should use registerMoneyParser for custom conversion", async () => {
      // Register custom parser: large amounts use custom token
      svmServer.registerMoneyParser(async (amount, _network) => {
        if (amount > 100) {
          return {
            amount: (amount * 1e9).toString(), // Custom token with 9 decimals
            asset: "CustomLargeTokenMint111111111111111",
            extra: { token: "CUSTOM", tier: "large" },
          };
        }
        return null; // Use default for small amounts
      });

      // Test large amount - should use custom parser
      const largeRequirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: RESOURCE_SERVER_ADDRESS,
        price: 150, // Large amount
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network,
      });

      expect(largeRequirements[0].amount).toBe((150 * 1e9).toString());
      expect(largeRequirements[0].asset).toBe("CustomLargeTokenMint111111111111111");
      expect(largeRequirements[0].extra?.token).toBe("CUSTOM");
      expect(largeRequirements[0].extra?.tier).toBe("large");

      // Test small amount - should use default USDC
      const smallRequirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: RESOURCE_SERVER_ADDRESS,
        price: 50, // Small amount
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network,
      });

      expect(smallRequirements[0].amount).toBe("50000000"); // 50 * 1e6 (USDC)
      expect(smallRequirements[0].asset).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // Devnet USDC
    });

    it("should support multiple MoneyParser in chain", async () => {
      svmServer
        .registerMoneyParser(async amount => {
          if (amount > 1000) {
            return {
              amount: (amount * 1e9).toString(),
              asset: "VIPTokenMint111111111111111111111111",
              extra: { tier: "vip" },
            };
          }
          return null;
        })
        .registerMoneyParser(async amount => {
          if (amount > 100) {
            return {
              amount: (amount * 1e6).toString(),
              asset: "PremiumTokenMint1111111111111111111",
              extra: { tier: "premium" },
            };
          }
          return null;
        });
      // < 100 uses default USDC

      // VIP tier
      const vipReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: RESOURCE_SERVER_ADDRESS,
        price: 2000,
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network,
      });
      expect(vipReq[0].extra?.tier).toBe("vip");
      expect(vipReq[0].asset).toBe("VIPTokenMint111111111111111111111111");

      // Premium tier
      const premiumReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: RESOURCE_SERVER_ADDRESS,
        price: 500,
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network,
      });
      expect(premiumReq[0].extra?.tier).toBe("premium");
      expect(premiumReq[0].asset).toBe("PremiumTokenMint1111111111111111111");

      // Standard tier (default)
      const standardReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: RESOURCE_SERVER_ADDRESS,
        price: 50,
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network,
      });
      expect(standardReq[0].asset).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // Default USDC
    });

    it("should work with async MoneyParser (e.g., exchange rate lookup)", async () => {
      const mockExchangeRate = 0.98;

      svmServer.registerMoneyParser(async (amount, _network) => {
        // Simulate async API call
        await new Promise(resolve => setTimeout(resolve, 10));

        const usdcAmount = amount * mockExchangeRate;
        return {
          amount: Math.floor(usdcAmount * 1e6).toString(),
          asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          extra: {
            exchangeRate: mockExchangeRate,
            originalUSD: amount,
          },
        };
      });

      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: RESOURCE_SERVER_ADDRESS,
        price: 100,
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network,
      });

      // 100 USD * 0.98 = 98 USDC
      expect(requirements[0].amount).toBe("98000000");
      expect(requirements[0].extra?.exchangeRate).toBe(0.98);
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
          payTo: RESOURCE_SERVER_ADDRESS,
          price: testCase.input,
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network,
        });

        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(testCase.expectedAmount);
        expect(requirements[0].asset).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // Devnet USDC
      }
    });
  });
});
