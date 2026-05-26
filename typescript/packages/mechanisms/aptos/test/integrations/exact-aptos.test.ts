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
import { ExactAptosScheme as ExactAptosClient } from "../../src/exact/client/scheme";
import { ExactAptosScheme as ExactAptosServer } from "../../src/exact/server/scheme";
import { ExactAptosScheme as ExactAptosFacilitator } from "../../src/exact/facilitator/scheme";
import { createClientSigner, toFacilitatorAptosSigner } from "../../src";
import type { ExactAptosPayload } from "../../src/types";

// Load private keys from environment
const CLIENT_PRIVATE_KEY = process.env.APTOS_CLIENT_PRIVATE_KEY;
const FACILITATOR_PRIVATE_KEY = process.env.APTOS_FACILITATOR_PRIVATE_KEY;

if (!CLIENT_PRIVATE_KEY || !FACILITATOR_PRIVATE_KEY) {
  throw new Error(
    "APTOS_CLIENT_PRIVATE_KEY and APTOS_FACILITATOR_PRIVATE_KEY environment variables must be set for integration tests",
  );
}

// Aptos testnet USDC address
const USDC_TESTNET = "0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832";

/**
 * Aptos Facilitator Client wrapper
 * Wraps the x402Facilitator for use with x402ResourceServer
 */
class AptosFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = "aptos:2"; // Testnet
  readonly x402Version = 2;

  /**
   * Creates a new AptosFacilitatorClient instance
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
    return Promise.resolve(this.facilitator.getSupported());
  }
}

/**
 * Build Aptos payment requirements for testing
 *
 * @param payTo - The recipient address
 * @param amount - The payment amount in smallest units
 * @param feePayer - Optional fee payer address (undefined for non-sponsored)
 * @param network - The network identifier (defaults to Aptos Testnet)
 * @returns Payment requirements object
 */
function buildAptosPaymentRequirements(
  payTo: string,
  amount: string,
  feePayer?: string,
  network: Network = "aptos:2",
): PaymentRequirements {
  return {
    scheme: "exact",
    network,
    asset: USDC_TESTNET,
    amount,
    payTo,
    maxTimeoutSeconds: 3600,
    extra: feePayer ? { feePayer } : {},
  };
}

describe("Aptos Integration Tests", () => {
  describe("x402Client / x402ResourceServer / x402Facilitator - Aptos Flow", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let clientAddress: string;
    let facilitatorAddress: string;

    beforeEach(async () => {
      // Create client account and signer from environment variable
      const clientAccount = await createClientSigner(CLIENT_PRIVATE_KEY);
      clientAddress = clientAccount.accountAddress.toStringLong();

      const aptosClient = new ExactAptosClient(clientAccount);
      client = new x402Client().register("aptos:2", aptosClient);

      // Create facilitator account and signer from environment variable
      const facilitatorAccount = await createClientSigner(FACILITATOR_PRIVATE_KEY);
      facilitatorAddress = facilitatorAccount.accountAddress.toStringLong();
      const facilitatorSigner = toFacilitatorAptosSigner(facilitatorAccount);

      const aptosFacilitator = new ExactAptosFacilitator(facilitatorSigner);
      const facilitator = new x402Facilitator().register("aptos:2", aptosFacilitator);

      const facilitatorClient = new AptosFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);
      server.register("aptos:2", new ExactAptosServer());
      await server.initialize(); // Initialize to fetch supported kinds
    });

    it("server should successfully verify an Aptos payment from a client", async () => {
      // Server - builds PaymentRequired response
      const accepts = [
        buildAptosPaymentRequirements(
          "0x0000000000000000000000000000000000000000000000000000000000000001",
          "1000", // 0.001 USDC
          facilitatorAddress,
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
      expect(paymentPayload.accepted.network).toBe("aptos:2");

      // Verify the payload structure
      const aptosPayload = paymentPayload.payload as ExactAptosPayload;
      expect(aptosPayload.transaction).toBeDefined();
      expect(typeof aptosPayload.transaction).toBe("string");

      // Server - maps payment payload to payment requirements
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);

      if (!verifyResponse.isValid) {
        console.log("Verification failed!");
        console.log("Invalid reason:", verifyResponse.invalidReason);
        console.log("Payer:", verifyResponse.payer);
        console.log("Client address:", clientAddress);
      }

      expect(verifyResponse.isValid).toBe(true);
      expect(verifyResponse.payer).toBe(clientAddress);
    });

    it("client should create a non-sponsored payment payload when feePayer is not provided", async () => {
      // Payment requirements without feePayer (non-sponsored mode)
      const accepts = [
        buildAptosPaymentRequirements(
          "0x0000000000000000000000000000000000000000000000000000000000000001",
          "1000",
          undefined, // No fee payer - client pays gas
        ),
      ];
      const resource = {
        url: "https://company.co",
        description: "Company Co. resource",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      // Client should create payload without fee payer
      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      expect(paymentPayload).toBeDefined();
      expect(paymentPayload.x402Version).toBe(2);
      expect(paymentPayload.accepted.scheme).toBe("exact");
      expect(paymentPayload.accepted.network).toBe("aptos:2");

      const aptosPayload = paymentPayload.payload as ExactAptosPayload;
      expect(aptosPayload.transaction).toBeDefined();
      expect(typeof aptosPayload.transaction).toBe("string");
    });

    it("server should successfully verify a non-sponsored Aptos payment", async () => {
      // Create a non-sponsoring facilitator
      const facilitatorAccount = await createClientSigner(FACILITATOR_PRIVATE_KEY);
      const facilitatorSigner = toFacilitatorAptosSigner(facilitatorAccount);
      const aptosFacilitator = new ExactAptosFacilitator(facilitatorSigner, false); // sponsorTransactions = false
      const facilitator = new x402Facilitator().register("aptos:2", aptosFacilitator);

      const facilitatorClient = new AptosFacilitatorClient(facilitator);
      const nonSponsoringServer = new x402ResourceServer(facilitatorClient);
      nonSponsoringServer.register("aptos:2", new ExactAptosServer());
      await nonSponsoringServer.initialize();

      // Payment requirements without feePayer (non-sponsored mode)
      const accepts = [
        buildAptosPaymentRequirements(
          "0x0000000000000000000000000000000000000000000000000000000000000001",
          "1000",
          undefined, // No fee payer - client pays gas
        ),
      ];
      const resource = {
        url: "https://company.co",
        description: "Company Co. resource",
        mimeType: "application/json",
      };
      const paymentRequired = await nonSponsoringServer.createPaymentRequiredResponse(
        accepts,
        resource,
      );

      // Client creates non-sponsored payload
      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      expect(paymentPayload).toBeDefined();
      expect(paymentPayload.accepted.extra?.feePayer).toBeUndefined();

      // Server verifies the non-sponsored payment
      const accepted = nonSponsoringServer.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await nonSponsoringServer.verifyPayment(paymentPayload, accepted!);

      if (!verifyResponse.isValid) {
        console.log("Non-sponsored verification failed!");
        console.log("Invalid reason:", verifyResponse.invalidReason);
      }

      expect(verifyResponse.isValid).toBe(true);
      expect(verifyResponse.payer).toBe(clientAddress);
    });
  });

  describe("x402HTTPClient / x402HTTPResourceServer / x402Facilitator - Aptos Flow", () => {
    let client: x402HTTPClient;
    let httpServer: x402HTTPResourceServer;

    const routes = {
      "/api/protected": {
        accepts: {
          scheme: "exact",
          payTo: "0x0000000000000000000000000000000000000000000000000000000000000001",
          price: "$0.001",
          network: "aptos:2" as Network,
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
      // Create facilitator account and signer from environment variable
      const facilitatorAccount = await createClientSigner(FACILITATOR_PRIVATE_KEY);
      const facilitatorSigner = toFacilitatorAptosSigner(facilitatorAccount);

      const aptosFacilitator = new ExactAptosFacilitator(facilitatorSigner);
      const facilitator = new x402Facilitator().register("aptos:2", aptosFacilitator);

      const facilitatorClient = new AptosFacilitatorClient(facilitator);

      // Create client account and signer from environment variable
      const clientAccount = await createClientSigner(CLIENT_PRIVATE_KEY);

      const aptosClient = new ExactAptosClient(clientAccount);
      const paymentClient = new x402Client().register("aptos:2", aptosClient);
      client = new x402HTTPClient(paymentClient) as x402HTTPClient;

      // Create resource server and register schemes (composition pattern)
      const ResourceServer = new x402ResourceServer(facilitatorClient);
      ResourceServer.register("aptos:2", new ExactAptosServer());
      await ResourceServer.initialize(); // Initialize to fetch supported kinds

      httpServer = new x402HTTPResourceServer(ResourceServer, routes);
    });

    it("middleware should successfully verify an Aptos payment from an http client", async () => {
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
      expect(paymentPayload.accepted.network).toBe("aptos:2");

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
    });
  });

  describe("Price Parsing Integration", () => {
    let server: x402ResourceServer;
    let aptosServer: ExactAptosServer;

    beforeEach(async () => {
      const facilitatorAccount = await createClientSigner(FACILITATOR_PRIVATE_KEY);
      const facilitatorSigner = toFacilitatorAptosSigner(facilitatorAccount);
      const facilitator = new x402Facilitator().register(
        "aptos:2",
        new ExactAptosFacilitator(facilitatorSigner),
      );

      const facilitatorClient = new AptosFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);

      aptosServer = new ExactAptosServer();
      server.register("aptos:2", aptosServer);
      await server.initialize();
    });

    it("should parse Money formats and build payment requirements", async () => {
      // Test different Money formats
      // USDC has 6 decimals
      const testCases = [
        { input: "$1.00", expectedAmount: "1000000" },
        { input: "1.50", expectedAmount: "1500000" },
        { input: 2.5, expectedAmount: "2500000" },
      ];

      for (const testCase of testCases) {
        const requirements = await server.buildPaymentRequirements({
          scheme: "exact",
          payTo: "0x0000000000000000000000000000000000000000000000000000000000000001",
          price: testCase.input,
          network: "aptos:2" as Network,
        });

        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(testCase.expectedAmount);
        expect(requirements[0].asset).toBe(USDC_TESTNET);
      }
    });

    it("should handle AssetAmount pass-through", async () => {
      const customAsset = {
        amount: "5000000",
        asset: "0x0000000000000000000000000000000000000000000000000000000000000abc",
        extra: { foo: "bar" },
      };

      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: "0x0000000000000000000000000000000000000000000000000000000000000001",
        price: customAsset,
        network: "aptos:2" as Network,
      });

      expect(requirements).toHaveLength(1);
      expect(requirements[0].amount).toBe("5000000");
      expect(requirements[0].asset).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000abc",
      );
      expect(requirements[0].extra?.foo).toBe("bar");
    });

    it("should use registerMoneyParser for custom conversion", async () => {
      // register custom parser: large amounts use a different token
      aptosServer.registerMoneyParser(async (amount, _network) => {
        if (amount > 100) {
          return {
            amount: (amount * 1e8).toString(), // APT has 8 decimals
            asset: "0x000000000000000000000000000000000000000000000000000000000000000a", // APT
            extra: { token: "APT", tier: "large" },
          };
        }
        return null; // Use default for small amounts
      });

      // Test large amount - should use custom parser
      const largeRequirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: "0x0000000000000000000000000000000000000000000000000000000000000001",
        price: 150, // Large amount
        network: "aptos:2" as Network,
      });

      expect(largeRequirements[0].amount).toBe((150 * 1e8).toString());
      expect(largeRequirements[0].asset).toBe(
        "0x000000000000000000000000000000000000000000000000000000000000000a",
      );
      expect(largeRequirements[0].extra?.token).toBe("APT");
      expect(largeRequirements[0].extra?.tier).toBe("large");

      // Test small amount - should use default USDC
      const smallRequirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: "0x0000000000000000000000000000000000000000000000000000000000000001",
        price: 50, // Small amount
        network: "aptos:2" as Network,
      });

      expect(smallRequirements[0].amount).toBe("50000000"); // 50 * 1e6 (USDC)
      expect(smallRequirements[0].asset).toBe(USDC_TESTNET);
    });

    it("should support multiple MoneyParser in chain", async () => {
      aptosServer
        .registerMoneyParser(async amount => {
          if (amount > 1000) {
            return {
              amount: (amount * 1e8).toString(),
              asset: "0xAPT",
              extra: { tier: "vip" },
            };
          }
          return null;
        })
        .registerMoneyParser(async amount => {
          if (amount > 100) {
            return {
              amount: (amount * 1e6).toString(),
              asset: "0xUSDT",
              extra: { tier: "premium" },
            };
          }
          return null;
        });
      // < 100 uses default USDC

      // VIP tier
      const vipReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: "0x0000000000000000000000000000000000000000000000000000000000000001",
        price: 2000,
        network: "aptos:2" as Network,
      });
      expect(vipReq[0].extra?.tier).toBe("vip");
      expect(vipReq[0].asset).toBe("0xAPT");

      // Premium tier
      const premiumReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: "0x0000000000000000000000000000000000000000000000000000000000000001",
        price: 500,
        network: "aptos:2" as Network,
      });
      expect(premiumReq[0].extra?.tier).toBe("premium");
      expect(premiumReq[0].asset).toBe("0xUSDT");

      // Standard tier (default)
      const standardReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: "0x0000000000000000000000000000000000000000000000000000000000000001",
        price: 50,
        network: "aptos:2" as Network,
      });
      expect(standardReq[0].asset).toBe(USDC_TESTNET);
    });

    it("should avoid floating-point rounding error", async () => {
      // Test different Money formats
      const testCases = [
        { input: "$4.02", expectedAmount: "4020000" },
        { input: "4.02", expectedAmount: "4020000" },
        { input: 4.02, expectedAmount: "4020000" },
      ];

      for (const testCase of testCases) {
        const requirements = await server.buildPaymentRequirements({
          scheme: "exact",
          payTo: "0x0000000000000000000000000000000000000000000000000000000000000001",
          price: testCase.input,
          network: "aptos:2" as Network,
        });

        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(testCase.expectedAmount);
        expect(requirements[0].asset).toBe(USDC_TESTNET);
      }
    });
  });
});
