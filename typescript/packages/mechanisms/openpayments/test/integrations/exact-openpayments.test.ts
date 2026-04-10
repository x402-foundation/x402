import { x402Client, x402HTTPClient } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  FacilitatorClient,
  HTTPAdapter,
  HTTPResponseInstructions,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ExactOpenPaymentsScheme as ExactOpenPaymentsClient } from "../../src";
import { OPEN_PAYMENTS_NETWORK } from "../../src/constants";
import { ExactOpenPaymentsScheme as ExactOpenPaymentsFacilitator } from "../../src/exact/facilitator/scheme";
import { ExactOpenPaymentsScheme as ExactOpenPaymentsServer } from "../../src/exact/server/scheme";
import { InMemoryPaymentUrlCache } from "../../src/types";
import { discoverWalletAddress, generatePaymentUrlCacheKey } from "../../src/utils";
import type { OpenPaymentsPayload } from "../../src/types";

// Load private keys and addresses from environment
const ILP_CLIENT_WALLET_ADDRESS = process.env.ILP_CLIENT_WALLET_ADDRESS;
const ILP_CLIENT_KEY_ID = process.env.ILP_CLIENT_KEY_ID;
const ILP_CLIENT_PRIVATE_KEY = process.env.ILP_CLIENT_PRIVATE_KEY;
const ILP_CLIENT_GRANT_TOKEN = process.env.ILP_CLIENT_GRANT_TOKEN;
const ILP_FACILITATOR_WALLET_ADDRESS = process.env.ILP_FACILITATOR_WALLET_ADDRESS;
const ILP_FACILITATOR_KEY_ID = process.env.ILP_FACILITATOR_KEY_ID;
const ILP_FACILITATOR_PRIVATE_KEY = process.env.ILP_FACILITATOR_PRIVATE_KEY;
const ILP_SERVER_WALLET_ADDRESS = process.env.ILP_SERVER_WALLET_ADDRESS;

const missingEnvVars =
  !ILP_CLIENT_WALLET_ADDRESS ||
  !ILP_CLIENT_KEY_ID ||
  !ILP_CLIENT_PRIVATE_KEY ||
  !ILP_CLIENT_GRANT_TOKEN ||
  !ILP_FACILITATOR_WALLET_ADDRESS ||
  !ILP_FACILITATOR_KEY_ID ||
  !ILP_FACILITATOR_PRIVATE_KEY ||
  !ILP_SERVER_WALLET_ADDRESS;

/**
 * Open Payments Facilitator Client wrapper.
 * Wraps the x402Facilitator for use with x402ResourceServer.
 */
class OpenPaymentsFacilitatorClient implements FacilitatorClient {
  /** Scheme identifier. */
  readonly scheme = "exact";

  /** Network identifier for Open Payments. */
  readonly network = OPEN_PAYMENTS_NETWORK;

  /** Protocol version. */
  readonly x402Version = 2;

  /**
   * Creates a new OpenPaymentsFacilitatorClient.
   *
   * @param facilitator - The x402 facilitator to wrap
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * Verifies a payment payload.
   *
   * @param paymentPayload - The payment payload to verify
   * @param paymentRequirements - The payment requirements
   * @returns Promise resolving to the verification response
   */
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  /**
   * Settles a payment.
   *
   * @param paymentPayload - The payment payload to settle
   * @param paymentRequirements - The payment requirements
   * @returns Promise resolving to the settlement response
   */
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  /**
   * Returns supported payment kinds.
   *
   * @returns Promise resolving to the supported response
   */
  getSupported(): Promise<SupportedResponse> {
    // Delegate to actual facilitator to get real supported kinds
    return Promise.resolve(this.facilitator.getSupported() as SupportedResponse);
  }
}

/**
 * Builds Open Payments payment requirements for testing.
 *
 * @param payTo - Server wallet address URL
 * @param amount - Amount in smallest asset units
 * @param assetCode - Asset code (e.g. "USD")
 * @param assetScale - Asset scale (e.g. 2 for USD cents)
 * @returns Payment requirements object
 */
function buildOpenPaymentsPaymentRequirements(
  payTo: string,
  amount: string,
  assetCode: string,
  assetScale: number,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: OPEN_PAYMENTS_NETWORK,
    asset: assetCode,
    amount,
    payTo,
    maxTimeoutSeconds: 30,
    extra: { assetScale },
  };
}

/**
 * Converts a decimal string to smallest asset units using string arithmetic,
 * mirroring the server's decimalToSmallestUnit to avoid floating-point error in tests.
 *
 * @param decimal - Decimal string e.g. "0.01"
 * @param scale - Asset scale
 * @returns Smallest unit value as a string
 */
function decimalToSmallestUnit(decimal: string, scale: number): string {
  const [intPart, fracPart = ""] = decimal.split(".");
  const paddedFrac = fracPart.slice(0, scale).padEnd(scale, "0");
  return BigInt((intPart || "0") + paddedFrac).toString();
}

/**
 * Logs the incoming payment URL after settlement for debugging failed tests.
 *
 * @param url - The incoming payment URL returned as the transaction reference
 */
function logIncomingPaymentUrl(url: string): void {
  console.log(`Open Payments incoming payment: ${url}`);
}

describe.skipIf(missingEnvVars)("Open Payments Integration Tests", () => {
  let walletAssetCode: string;
  let walletAssetScale: number;

  beforeAll(async () => {
    const walletInfo = await discoverWalletAddress(ILP_SERVER_WALLET_ADDRESS!);
    walletAssetCode = walletInfo.assetCode ?? "USD";
    walletAssetScale = walletInfo.assetScale ?? 2;
  });

  describe("x402Client / x402ResourceServer / x402Facilitator - Open Payments Flow", () => {
    let client: x402Client;
    let server: x402ResourceServer;

    beforeEach(async () => {
      const opClient = new ExactOpenPaymentsClient({
        clientWalletAddress: ILP_CLIENT_WALLET_ADDRESS!,
        keyId: ILP_CLIENT_KEY_ID!,
        privateKey: ILP_CLIENT_PRIVATE_KEY!,
        grantToken: ILP_CLIENT_GRANT_TOKEN!,
      });
      client = new x402Client().register(OPEN_PAYMENTS_NETWORK, opClient);

      const opFacilitator = new ExactOpenPaymentsFacilitator({
        walletAddress: ILP_FACILITATOR_WALLET_ADDRESS!,
        keyId: ILP_FACILITATOR_KEY_ID!,
        privateKey: ILP_FACILITATOR_PRIVATE_KEY!,
        maxRetries: 3,
        retryDelayMs: 1000,
      });
      const facilitator = new x402Facilitator().register(OPEN_PAYMENTS_NETWORK, opFacilitator);
      const facilitatorClient = new OpenPaymentsFacilitatorClient(facilitator);

      server = new x402ResourceServer(facilitatorClient);
      server.register(
        OPEN_PAYMENTS_NETWORK,
        new ExactOpenPaymentsServer({ walletAddress: ILP_SERVER_WALLET_ADDRESS! }),
      );
      await server.initialize();
    });

    it(
      "server should successfully verify and settle an Open Payments payment from a client",
      { timeout: 30000 },
      async () => {
        // Server - builds PaymentRequired response
        const accepts = [
          buildOpenPaymentsPaymentRequirements(
            ILP_SERVER_WALLET_ADDRESS!,
            decimalToSmallestUnit("0.01", walletAssetScale),
            walletAssetCode,
            walletAssetScale,
          ),
        ];
        const resource = {
          url: "https://example.com/api/resource",
          description: "Open Payments integration test resource",
          mimeType: "application/json",
        };
        const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

        // Client - sends ILP payment and returns the incoming payment URL as proof
        const paymentPayload = await client.createPaymentPayload(paymentRequired);

        expect(paymentPayload).toBeDefined();
        expect(paymentPayload.x402Version).toBe(2);
        expect(paymentPayload.accepted.scheme).toBe("exact");

        // Verify the payload structure
        const opPayload = paymentPayload.payload as OpenPaymentsPayload;
        expect(opPayload.incomingPaymentUrl).toBeDefined();
        expect(opPayload.incomingPaymentUrl).toMatch(/^https?:\/\//);
        // Confirm the payment was created at the correct server, not a rogue wallet.
        expect(new URL(opPayload.incomingPaymentUrl).host).toBe(
          new URL(ILP_SERVER_WALLET_ADDRESS!).host,
        );

        // Server - maps payment payload to payment requirements
        const accepted = server.findMatchingRequirements(accepts, paymentPayload);
        expect(accepted).toBeDefined();

        const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);

        if (!verifyResponse.isValid) {
          console.log("❌ Verification failed!");
          console.log("Invalid reason:", verifyResponse.invalidReason);
          console.log("Payload:", JSON.stringify(paymentPayload, null, 2));
        }

        expect(verifyResponse.isValid).toBe(true);
        // Unlike EVM/Stellar, ILP verify() returns no payer — funds already moved before verify is called.

        // Server does work here
        const settleResponse = await server.settlePayment(paymentPayload, accepted!);
        expect(settleResponse.success).toBe(true);
        expect(settleResponse.network).toBe(OPEN_PAYMENTS_NETWORK);
        // settle() is a no-op for ILP; it returns the incomingPaymentUrl as the transaction reference.
        expect(settleResponse.transaction).toBe(opPayload.incomingPaymentUrl);
        logIncomingPaymentUrl(settleResponse.transaction);
      },
    );
  });

  describe("x402HTTPClient / x402HTTPResourceServer / x402Facilitator - Open Payments Flow", () => {
    let client: x402HTTPClient;
    let httpServer: x402HTTPResourceServer;

    const routes = {
      "/api/protected": {
        accepts: {
          scheme: "exact",
          payTo: ILP_SERVER_WALLET_ADDRESS!,
          price: "0.01",
          network: OPEN_PAYMENTS_NETWORK as Network,
        },
        description: "Access to protected API",
        mimeType: "application/json",
      },
    };

    const mockAdapter: HTTPAdapter = {
      getHeader: () => undefined,
      getMethod: () => "GET",
      getPath: () => "/api/protected",
      getUrl: () => "https://example.com/api/protected",
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "TestClient/1.0",
    };

    beforeEach(async () => {
      mockAdapter.getHeader = () => undefined;

      const opFacilitator = new ExactOpenPaymentsFacilitator({
        walletAddress: ILP_FACILITATOR_WALLET_ADDRESS!,
        keyId: ILP_FACILITATOR_KEY_ID!,
        privateKey: ILP_FACILITATOR_PRIVATE_KEY!,
        maxRetries: 3,
        retryDelayMs: 1000,
      });
      const facilitator = new x402Facilitator().register(OPEN_PAYMENTS_NETWORK, opFacilitator);
      const facilitatorClient = new OpenPaymentsFacilitatorClient(facilitator);

      const opClient = new ExactOpenPaymentsClient({
        clientWalletAddress: ILP_CLIENT_WALLET_ADDRESS!,
        keyId: ILP_CLIENT_KEY_ID!,
        privateKey: ILP_CLIENT_PRIVATE_KEY!,
        grantToken: ILP_CLIENT_GRANT_TOKEN!,
      });
      const paymentClient = new x402Client().register(OPEN_PAYMENTS_NETWORK, opClient);
      client = new x402HTTPClient(paymentClient) as x402HTTPClient;

      const resourceServer = new x402ResourceServer(facilitatorClient);
      resourceServer.register(
        OPEN_PAYMENTS_NETWORK,
        new ExactOpenPaymentsServer({ walletAddress: ILP_SERVER_WALLET_ADDRESS! }),
      );
      await resourceServer.initialize();

      httpServer = new x402HTTPResourceServer(resourceServer, routes);
    });

    it(
      "middleware should successfully verify and settle an Open Payments payment from an http client",
      { timeout: 30000 },
      async () => {
        const context = {
          adapter: mockAdapter,
          path: "/api/protected",
          method: "GET",
        };

        // Middleware creates a PaymentRequired response
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

        expect(verifiedPaymentPayload.accepted.scheme).toBe("exact");
        expect(verifiedPaymentPayload.accepted.network).toBe(OPEN_PAYMENTS_NETWORK);
        expect(verifiedPaymentPayload.payload).toEqual(paymentPayload.payload);
        expect(verifiedPaymentRequirements.payTo).toBe(ILP_SERVER_WALLET_ADDRESS);

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
          logIncomingPaymentUrl(settlementResult.transaction);
        }
      },
    );
  });

  describe("Replay Prevention", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let cache: InMemoryPaymentUrlCache;

    beforeEach(async () => {
      cache = new InMemoryPaymentUrlCache();

      const opClient = new ExactOpenPaymentsClient({
        clientWalletAddress: ILP_CLIENT_WALLET_ADDRESS!,
        keyId: ILP_CLIENT_KEY_ID!,
        privateKey: ILP_CLIENT_PRIVATE_KEY!,
        grantToken: ILP_CLIENT_GRANT_TOKEN!,
      });
      client = new x402Client().register(OPEN_PAYMENTS_NETWORK, opClient);

      const opFacilitator = new ExactOpenPaymentsFacilitator({
        walletAddress: ILP_FACILITATOR_WALLET_ADDRESS!,
        keyId: ILP_FACILITATOR_KEY_ID!,
        privateKey: ILP_FACILITATOR_PRIVATE_KEY!,
        maxRetries: 3,
        retryDelayMs: 1000,
        usedPaymentUrlsCache: cache,
        // Short window so tests don't have to sleep long to trigger expiry.
        idempotencyWindowMs: 100,
      });
      const facilitator = new x402Facilitator().register(OPEN_PAYMENTS_NETWORK, opFacilitator);
      const facilitatorClient = new OpenPaymentsFacilitatorClient(facilitator);

      server = new x402ResourceServer(facilitatorClient);
      server.register(
        OPEN_PAYMENTS_NETWORK,
        new ExactOpenPaymentsServer({ walletAddress: ILP_SERVER_WALLET_ADDRESS! }),
      );
      await server.initialize();
    });

    it(
      "allows the same payment URL within the idempotency window then rejects it after expiry",
      { timeout: 30000 },
      async () => {
        const accepts = [
          buildOpenPaymentsPaymentRequirements(
            ILP_SERVER_WALLET_ADDRESS!,
            decimalToSmallestUnit("0.01", walletAssetScale),
            walletAssetCode,
            walletAssetScale,
          ),
        ];
        const resource = {
          url: "https://example.com/api/resource",
          description: "Replay prevention test resource",
          mimeType: "application/json",
        };

        const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
        const paymentPayload = await client.createPaymentPayload(paymentRequired);
        const accepted = server.findMatchingRequirements(accepts, paymentPayload);
        expect(accepted).toBeDefined();

        // First verify — succeeds and writes the URL to the cache.
        const first = await server.verifyPayment(paymentPayload, accepted!);
        expect(first.isValid).toBe(true);

        // Second verify immediately — still within the idempotency window.
        // Models a legitimate network retry of the same request.
        const second = await server.verifyPayment(paymentPayload, accepted!);
        expect(second.isValid).toBe(true);

        // Expire the cache entry by backdating it past idempotencyWindowMs.
        const opPayload = paymentPayload.payload as OpenPaymentsPayload;
        const cacheKey = generatePaymentUrlCacheKey(opPayload.incomingPaymentUrl, resource.url);
        const entry = cache.get(cacheKey)!;
        cache.set(cacheKey, { ...entry, timestamp: Date.now() - 200 });

        // Third verify — window has expired; the URL is now rejected as a replay.
        const third = await server.verifyPayment(paymentPayload, accepted!);
        expect(third.isValid).toBe(false);
        expect(third.invalidReason).toBe("invalid_exact_openpayments_payload_url_already_used");
      },
    );
  });

  describe("Price Parsing Integration", () => {
    let server: x402ResourceServer;
    let opServer: ExactOpenPaymentsServer;

    beforeEach(async () => {
      const opFacilitator = new ExactOpenPaymentsFacilitator({
        walletAddress: ILP_FACILITATOR_WALLET_ADDRESS!,
        keyId: ILP_FACILITATOR_KEY_ID!,
        privateKey: ILP_FACILITATOR_PRIVATE_KEY!,
        maxRetries: 0,
        retryDelayMs: 0,
      });
      const facilitator = new x402Facilitator().register(OPEN_PAYMENTS_NETWORK, opFacilitator);
      const facilitatorClient = new OpenPaymentsFacilitatorClient(facilitator);

      server = new x402ResourceServer(facilitatorClient);
      opServer = new ExactOpenPaymentsServer({ walletAddress: ILP_SERVER_WALLET_ADDRESS! });
      server.register(OPEN_PAYMENTS_NETWORK, opServer);
      await server.initialize();
    });

    it("should parse money string formats and build payment requirements", async () => {
      const testCases = [
        { input: "0.01", decimal: "0.01" },
        { input: "$0.01", decimal: "0.01" },
        { input: 0.01, decimal: "0.01" },
      ];

      for (const testCase of testCases) {
        const requirements = await server.buildPaymentRequirements({
          scheme: "exact",
          payTo: ILP_SERVER_WALLET_ADDRESS!,
          price: testCase.input,
          network: OPEN_PAYMENTS_NETWORK as Network,
        });

        const expectedAmount = decimalToSmallestUnit(testCase.decimal, walletAssetScale);
        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(expectedAmount);
        expect(requirements[0].asset).toBe(walletAssetCode);
        expect(requirements[0].extra?.assetScale).toBe(walletAssetScale);
      }
    });

    it("should handle AssetAmount pass-through (decimal path)", async () => {
      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: ILP_SERVER_WALLET_ADDRESS!,
        price: { amount: "1.00", asset: walletAssetCode },
        network: OPEN_PAYMENTS_NETWORK as Network,
      });

      const expectedAmount = decimalToSmallestUnit("1.00", walletAssetScale);
      expect(requirements).toHaveLength(1);
      expect(requirements[0].amount).toBe(expectedAmount);
      expect(requirements[0].asset).toBe(walletAssetCode);
    });

    it("should handle AssetAmount with assetScale (scaled path)", async () => {
      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: ILP_SERVER_WALLET_ADDRESS!,
        price: { amount: "1", asset: walletAssetCode, extra: { assetScale: walletAssetScale } },
        network: OPEN_PAYMENTS_NETWORK as Network,
      });

      expect(requirements).toHaveLength(1);
      expect(requirements[0].amount).toBe("1");
      expect(requirements[0].asset).toBe(walletAssetCode);
      expect(requirements[0].extra?.assetScale).toBe(walletAssetScale);
    });

    it("should use registerMoneyParser for custom conversion", async () => {
      opServer.registerMoneyParser(async (amount, _) => {
        if (amount >= 10) {
          return {
            amount: decimalToSmallestUnit(amount.toFixed(walletAssetScale), walletAssetScale),
            asset: walletAssetCode,
            extra: { assetScale: walletAssetScale, tier: "premium" },
          };
        }
        return null;
      });

      // Large amount — custom parser applies
      const largeReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: ILP_SERVER_WALLET_ADDRESS!,
        price: 10,
        network: OPEN_PAYMENTS_NETWORK as Network,
      });
      expect(largeReq[0].extra?.tier).toBe("premium");

      // Small amount — default parser applies
      const smallReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: ILP_SERVER_WALLET_ADDRESS!,
        price: 0.01,
        network: OPEN_PAYMENTS_NETWORK as Network,
      });
      expect(smallReq[0].extra?.tier).toBeUndefined();
      expect(smallReq[0].amount).toBe(decimalToSmallestUnit("0.01", walletAssetScale));
    });

    it("should support multiple MoneyParsers in chain", async () => {
      opServer
        .registerMoneyParser(async (amount, _) => {
          if (amount >= 100) {
            return {
              amount: decimalToSmallestUnit(amount.toFixed(walletAssetScale), walletAssetScale),
              asset: walletAssetCode,
              extra: { assetScale: walletAssetScale, tier: "vip" },
            };
          }
          return null;
        })
        .registerMoneyParser(async (amount, _) => {
          if (amount >= 10) {
            return {
              amount: decimalToSmallestUnit(amount.toFixed(walletAssetScale), walletAssetScale),
              asset: walletAssetCode,
              extra: { assetScale: walletAssetScale, tier: "premium" },
            };
          }
          return null;
        });

      // VIP tier
      const vipReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: ILP_SERVER_WALLET_ADDRESS!,
        price: 100,
        network: OPEN_PAYMENTS_NETWORK as Network,
      });
      expect(vipReq[0].extra?.tier).toBe("vip");

      // Premium tier
      const premiumReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: ILP_SERVER_WALLET_ADDRESS!,
        price: 10,
        network: OPEN_PAYMENTS_NETWORK as Network,
      });
      expect(premiumReq[0].extra?.tier).toBe("premium");

      // Standard tier (default)
      const standardReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: ILP_SERVER_WALLET_ADDRESS!,
        price: 0.01,
        network: OPEN_PAYMENTS_NETWORK as Network,
      });
      expect(standardReq[0].extra?.tier).toBeUndefined();
      expect(standardReq[0].amount).toBe(decimalToSmallestUnit("0.01", walletAssetScale));
    });

    it("should work with async MoneyParser (e.g. exchange rate lookup)", async () => {
      const mockRate = 1.05;

      opServer.registerMoneyParser(async (amount, _) => {
        // Simulate async API call
        await new Promise(resolve => setTimeout(resolve, 10));
        const adjusted = amount * mockRate;
        return {
          amount: decimalToSmallestUnit(adjusted.toFixed(walletAssetScale), walletAssetScale),
          asset: walletAssetCode,
          extra: { assetScale: walletAssetScale, rate: mockRate },
        };
      });

      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: ILP_SERVER_WALLET_ADDRESS!,
        price: 1,
        network: OPEN_PAYMENTS_NETWORK as Network,
      });

      // 1 * 1.05 converted to smallest units
      const expectedAmount = decimalToSmallestUnit(
        (1 * mockRate).toFixed(walletAssetScale),
        walletAssetScale,
      );
      expect(requirements[0].amount).toBe(expectedAmount);
      expect(requirements[0].extra?.rate).toBe(mockRate);
    });

    it("should avoid floating-point rounding error", async () => {
      // 0.07 * 10^2 = 6.999... in IEEE 754; the server uses BigInt string arithmetic to produce "7".
      const testCases = [
        { input: "0.07", decimal: "0.07" },
        { input: "$0.07", decimal: "0.07" },
        { input: 0.07, decimal: "0.07" },
      ];

      for (const testCase of testCases) {
        const requirements = await server.buildPaymentRequirements({
          scheme: "exact",
          payTo: ILP_SERVER_WALLET_ADDRESS!,
          price: testCase.input,
          network: OPEN_PAYMENTS_NETWORK as Network,
        });

        const expectedAmount = decimalToSmallestUnit(testCase.decimal, walletAssetScale);
        expect(requirements[0].amount).toBe(expectedAmount);
      }
    });

    it("should adapt AssetAmount from a lower input scale to the wallet scale", async () => {
      // inputScale=0 means the amount is already a whole-unit integer.
      // If the wallet is at scale N, the amount must be multiplied by 10^N.
      const inputScale = 0;

      // Only run this assertion when the wallet scale is higher than the input scale,
      // i.e. the adaptation is non-trivial. Skip silently otherwise.
      if (walletAssetScale <= inputScale) {
        return;
      }

      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: ILP_SERVER_WALLET_ADDRESS!,
        price: { amount: "1", asset: walletAssetCode, extra: { assetScale: inputScale } },
        network: OPEN_PAYMENTS_NETWORK as Network,
      });

      const scaleDiff = walletAssetScale - inputScale;
      const expectedAmount = (1n * 10n ** BigInt(scaleDiff)).toString();
      expect(requirements[0].amount).toBe(expectedAmount);
      expect(requirements[0].extra?.assetScale).toBe(walletAssetScale);
    });
  });
});
