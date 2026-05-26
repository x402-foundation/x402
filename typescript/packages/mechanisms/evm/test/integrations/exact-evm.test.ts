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
import { ExactEvmScheme as ExactEvmClient, toFacilitatorEvmSigner } from "../../src";
import { ExactEvmScheme as ExactEvmServer } from "../../src/exact/server/scheme";
import { ExactEvmScheme as ExactEvmFacilitator } from "../../src/exact/facilitator/scheme";
import type { ExactEvmPayloadV2 } from "../../src/types";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

// Load private keys from environment
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY as `0x${string}`;
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`;

if (!CLIENT_PRIVATE_KEY || !FACILITATOR_PRIVATE_KEY) {
  throw new Error(
    "CLIENT_PRIVATE_KEY and FACILITATOR_PRIVATE_KEY environment variables must be set for integration tests",
  );
}

/**
 * EVM Facilitator Client wrapper
 * Wraps the x402Facilitator for use with x402ResourceServer
 */
class EvmFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = "eip155:84532"; // Base Sepolia
  readonly x402Version = 2;

  /**
   * Creates a new EvmFacilitatorClient instance
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
 * Build EVM payment requirements for testing
 *
 * @param payTo - The recipient address
 * @param amount - The payment amount in smallest units
 * @param network - The network identifier (defaults to Base Sepolia)
 * @returns Payment requirements object
 */
function buildEvmPaymentRequirements(
  payTo: string,
  amount: string,
  network: Network = "eip155:84532",
): PaymentRequirements {
  return {
    scheme: "exact",
    network,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia USDC
    amount,
    payTo,
    maxTimeoutSeconds: 3600,
    extra: {
      name: "USDC",
      version: "2",
    },
  };
}

describe("EVM Integration Tests", () => {
  describe("x402Client / x402ResourceServer / x402Facilitator - EVM Flow", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let clientAddress: `0x${string}`;

    beforeEach(async () => {
      // Create client account and signer from environment variable
      const clientAccount = privateKeyToAccount(CLIENT_PRIVATE_KEY);
      clientAddress = clientAccount.address;

      const evmClient = new ExactEvmClient(clientAccount);
      client = new x402Client().register("eip155:84532", evmClient);

      // Create facilitator account and signer from environment variable
      const facilitatorAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY);

      // Create separate public and wallet clients for the facilitator
      const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(),
      });

      const walletClient = createWalletClient({
        account: facilitatorAccount,
        chain: baseSepolia,
        transport: http(),
      });

      const facilitatorSigner = toFacilitatorEvmSigner({
        address: facilitatorAccount.address,
        readContract: args =>
          publicClient.readContract({
            ...args,
            args: args.args || [],
          } as never),
        verifyTypedData: args => publicClient.verifyTypedData(args as never),
        writeContract: args =>
          walletClient.writeContract({
            ...args,
            args: args.args || [],
          } as never),
        sendTransaction: args => walletClient.sendTransaction(args),
        waitForTransactionReceipt: args => publicClient.waitForTransactionReceipt(args),
        getCode: args => publicClient.getCode(args),
      });

      const evmFacilitator = new ExactEvmFacilitator(facilitatorSigner);
      const facilitator = new x402Facilitator().register("eip155:84532", evmFacilitator);

      const facilitatorClient = new EvmFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);
      server.register("eip155:84532", new ExactEvmServer());
      await server.initialize(); // Initialize to fetch supported kinds
    });

    it(
      "server should successfully verify and settle an EVM payment from a client",
      { timeout: 30000 },
      async () => {
        // Server - builds PaymentRequired response
        const accepts = [
          buildEvmPaymentRequirements(
            "0x9876543210987654321098765432109876543210",
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
        const evmPayload = paymentPayload.payload as ExactEvmPayloadV2;
        expect(evmPayload.authorization).toBeDefined();
        expect(evmPayload.authorization.from).toBe(clientAddress);
        expect(evmPayload.authorization.to).toBe("0x9876543210987654321098765432109876543210");
        expect(evmPayload.signature).toBeDefined();

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
        expect(settleResponse.success).toBe(true);
        expect(settleResponse.network).toBe("eip155:84532");
        expect(settleResponse.transaction).toBeDefined();
        expect(settleResponse.payer).toBe(clientAddress);
      },
    );
  });

  describe("x402HTTPClient / x402HTTPResourceServer / x402Facilitator - EVM Flow", () => {
    let client: x402HTTPClient;
    let httpServer: x402HTTPResourceServer;

    const routes = {
      "/api/protected": {
        accepts: {
          scheme: "exact",
          payTo: "0x9876543210987654321098765432109876543210",
          price: "$0.001",
          network: "eip155:84532" as Network,
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
      const facilitatorAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY);

      // Create separate public and wallet clients for the facilitator
      const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(),
      });

      const walletClient = createWalletClient({
        account: facilitatorAccount,
        chain: baseSepolia,
        transport: http(),
      });

      const facilitatorSigner = toFacilitatorEvmSigner({
        address: facilitatorAccount.address,
        readContract: args =>
          publicClient.readContract({
            ...args,
            args: args.args || [],
          }),
        verifyTypedData: args => publicClient.verifyTypedData(args as never),
        writeContract: args =>
          walletClient.writeContract({
            ...args,
            args: args.args || [],
          }),
        sendTransaction: args => walletClient.sendTransaction(args),
        waitForTransactionReceipt: args => publicClient.waitForTransactionReceipt(args),
        getCode: args => publicClient.getCode(args),
      });

      const evmFacilitator = new ExactEvmFacilitator(facilitatorSigner);
      const facilitator = new x402Facilitator().register("eip155:84532", evmFacilitator);

      const facilitatorClient = new EvmFacilitatorClient(facilitator);

      // Create client account and signer from environment variable
      const clientAccount = privateKeyToAccount(CLIENT_PRIVATE_KEY);

      const evmClient = new ExactEvmClient(clientAccount);
      const paymentClient = new x402Client().register("eip155:84532", evmClient);
      client = new x402HTTPClient(paymentClient) as x402HTTPClient;

      // Create resource server and register schemes (composition pattern)
      const ResourceServer = new x402ResourceServer(facilitatorClient);
      ResourceServer.register("eip155:84532", new ExactEvmServer());
      await ResourceServer.initialize(); // Initialize to fetch supported kinds

      httpServer = new x402HTTPResourceServer(ResourceServer, routes);
    });

    it("middleware should successfully verify and settle an EVM payment from an http client", async () => {
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
      expect(settlementResult.success).toBe(true);

      if (settlementResult.success) {
        expect(settlementResult.headers).toBeDefined();
        expect(settlementResult.headers["PAYMENT-RESPONSE"]).toBeDefined();
      }
    });
  });

  describe("Price Parsing Integration", () => {
    let server: x402ResourceServer;
    let evmServer: ExactEvmServer;

    beforeEach(async () => {
      const facilitatorAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY);
      const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(),
      });
      const walletClient = createWalletClient({
        account: facilitatorAccount,
        chain: baseSepolia,
        transport: http(),
      });

      const facilitatorSigner = toFacilitatorEvmSigner({
        address: facilitatorAccount.address,
        readContract: args =>
          publicClient.readContract({
            ...args,
            args: args.args || [],
          } as never),
        verifyTypedData: args => publicClient.verifyTypedData(args as never),
        writeContract: args =>
          walletClient.writeContract({
            ...args,
            args: args.args || [],
          } as never),
        sendTransaction: args => walletClient.sendTransaction(args),
        waitForTransactionReceipt: args => publicClient.waitForTransactionReceipt(args),
        getCode: args => publicClient.getCode(args),
      });
      const facilitator = new x402Facilitator().register(
        "eip155:84532",
        new ExactEvmFacilitator(facilitatorSigner),
      );

      const facilitatorClient = new EvmFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);

      evmServer = new ExactEvmServer();
      server.register("eip155:84532", evmServer);
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
          payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
          price: testCase.input,
          network: "eip155:84532" as Network,
        });

        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(testCase.expectedAmount);
        expect(requirements[0].asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e"); // Base Sepolia USDC
      }
    });

    it("should handle AssetAmount pass-through", async () => {
      const customAsset = {
        amount: "5000000",
        asset: "0xCustomToken1234567890123456789012345678",
        extra: { foo: "bar" },
      };

      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        price: customAsset,
        network: "eip155:84532" as Network,
      });

      expect(requirements).toHaveLength(1);
      expect(requirements[0].amount).toBe("5000000");
      expect(requirements[0].asset).toBe("0xCustomToken1234567890123456789012345678");
      expect(requirements[0].extra?.foo).toBe("bar");
    });

    it("should use registerMoneyParser for custom conversion", async () => {
      // register custom parser: large amounts use DAI
      evmServer.registerMoneyParser(async (amount, _network) => {
        if (amount > 100) {
          return {
            amount: (amount * 1e18).toString(), // DAI has 18 decimals
            asset: "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI on mainnet (test value)
            extra: { token: "DAI", tier: "large" },
          };
        }
        return null; // Use default for small amounts
      });

      // Test large amount - should use custom parser
      const largeRequirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        price: 150, // Large amount
        network: "eip155:84532" as Network,
      });

      expect(largeRequirements[0].amount).toBe((150 * 1e18).toString());
      expect(largeRequirements[0].asset).toBe("0x6B175474E89094C44Da98b954EedeAC495271d0F");
      expect(largeRequirements[0].extra?.token).toBe("DAI");
      expect(largeRequirements[0].extra?.tier).toBe("large");

      // Test small amount - should use default USDC
      const smallRequirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        price: 50, // Small amount
        network: "eip155:84532" as Network,
      });

      expect(smallRequirements[0].amount).toBe("50000000"); // 50 * 1e6 (USDC)
      expect(smallRequirements[0].asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e"); // Base Sepolia USDC
    });

    it("should support multiple MoneyParser in chain", async () => {
      evmServer
        .registerMoneyParser(async amount => {
          if (amount > 1000) {
            return {
              amount: (amount * 1e18).toString(),
              asset: "0xDAI",
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
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        price: 2000,
        network: "eip155:84532" as Network,
      });
      expect(vipReq[0].extra?.tier).toBe("vip");
      expect(vipReq[0].asset).toBe("0xDAI");

      // Premium tier
      const premiumReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        price: 500,
        network: "eip155:84532" as Network,
      });
      expect(premiumReq[0].extra?.tier).toBe("premium");
      expect(premiumReq[0].asset).toBe("0xUSDT");

      // Standard tier (default)
      const standardReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        price: 50,
        network: "eip155:84532" as Network,
      });
      expect(standardReq[0].asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e"); // Default USDC
    });

    it("should work with async MoneyParser (e.g., exchange rate lookup)", async () => {
      const mockExchangeRate = 1.02;

      evmServer.registerMoneyParser(async (amount, _network) => {
        // Simulate async API call
        await new Promise(resolve => setTimeout(resolve, 10));

        const usdcAmount = amount * mockExchangeRate;
        return {
          amount: Math.floor(usdcAmount * 1e6).toString(),
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          extra: {
            exchangeRate: mockExchangeRate,
            originalUSD: amount,
          },
        };
      });

      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        price: 100,
        network: "eip155:84532" as Network,
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
          payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
          price: testCase.input,
          network: "eip155:84532" as Network,
        });

        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(testCase.expectedAmount);
        expect(requirements[0].asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e"); // Base Sepolia USDC
      }
    });
  });
});
