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
  AssetAmount,
  Network,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  SupportedResponse,
} from "@x402/core/types";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEd25519Signer, Ed25519Signer, STELLAR_TESTNET_CAIP2 } from "../../src";
import { ExactStellarScheme as ExactStellarClient } from "../../src/exact/client";
import { ExactStellarScheme as ExactStellarFacilitator } from "../../src/exact/facilitator";
import { ExactStellarScheme as ExactStellarServer } from "../../src/exact/server";
import type { ExactStellarPayloadV2 } from "../../src/types";

// Load private keys and addresses from environment
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY;
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY;
const FACILITATOR_ADDRESS = process.env.FACILITATOR_ADDRESS;
const RESOURCE_SERVER_ADDRESS = process.env.RESOURCE_SERVER_ADDRESS;
const XLM_TESTNET_ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

async function xlmFallbackParser(amount: number, network: string): Promise<AssetAmount | null> {
  if (network === STELLAR_TESTNET_CAIP2) {
    return {
      amount: Math.round(amount * 1e7).toString(),
      asset: XLM_TESTNET_ASSET,
      extra: {},
    };
  }
  return null;
}

const missingEnvVars =
  !CLIENT_PRIVATE_KEY ||
  !FACILITATOR_PRIVATE_KEY ||
  !FACILITATOR_ADDRESS ||
  !RESOURCE_SERVER_ADDRESS;

const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const STELLAR_EXPERT_TESTNET_TX = "https://stellar.expert/explorer/testnet/tx";

function logStellarExpertTxUrl(txHash: string): void {
  console.log(`Stellar Expert (testnet): ${STELLAR_EXPERT_TESTNET_TX}/${txHash}`);
}

async function fundOneAccount(address: string): Promise<void> {
  const res = await fetch(`${HORIZON_TESTNET}/accounts/${address}`);
  if (res.status === 404) {
    console.log(`Account ${address} not found, funding with Friendbot\n`);
    const fb = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`);
    if (!fb.ok) {
      const body = await fb.text();
      throw new Error(`Friendbot failed for ${address}: ${fb.status} ${body}`);
    }
    console.log(`Account ${address} funded with Friendbot\n`);
  } else if (!res.ok) {
    throw new Error(`Horizon account check failed for ${address}: ${res.status}`);
  }
}

async function ensureAccountsFunded(addresses: string[]): Promise<void> {
  await Promise.all(addresses.map(fundOneAccount));
}

/**
 * Stellar Facilitator Client wrapper
 * Wraps the x402Facilitator for use with x402ResourceServer
 */
class StellarFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = STELLAR_TESTNET_CAIP2;
  readonly x402Version = 2;

  /**
   * Creates a new StellarFacilitatorClient instance
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
    return Promise.resolve(this.facilitator.getSupported() as SupportedResponse);
  }
}

/**
 * Build Stellar payment requirements for testing
 *
 * @param payTo - The recipient address
 * @param amount - The payment amount in smallest units
 * @param network - The network identifier (defaults to Stellar Testnet)
 * @returns Payment requirements object
 */
function buildStellarPaymentRequirements(
  payTo: string,
  amount: string,
  network: Network = STELLAR_TESTNET_CAIP2,
): PaymentRequirements {
  return {
    scheme: "exact",
    network,
    asset: XLM_TESTNET_ASSET,
    amount,
    payTo,
    maxTimeoutSeconds: 3600,
    extra: { areFeesSponsored: true },
  };
}

/**
 * Helper to check if an error is due to insufficient balance
 */
function isInsufficientBalanceError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes("resulting balance is not within the allowed range") ||
      error.message.includes("insufficient balance") ||
      error.message.includes("Error(Contract, #10)")
    );
  }
  return false;
}

describe.skipIf(missingEnvVars)("Stellar Integration Tests", () => {
  let clientAddress: string;
  let clientSigner: Ed25519Signer;
  let facilitatorSigner: Ed25519Signer;
  beforeAll(async () => {
    clientSigner = createEd25519Signer(CLIENT_PRIVATE_KEY!, STELLAR_TESTNET_CAIP2);
    clientAddress = clientSigner.address;

    facilitatorSigner = createEd25519Signer(FACILITATOR_PRIVATE_KEY, STELLAR_TESTNET_CAIP2);

    await ensureAccountsFunded([FACILITATOR_ADDRESS, RESOURCE_SERVER_ADDRESS, clientAddress]);
  });

  describe("x402Client / x402ResourceServer / x402Facilitator - Stellar Flow", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let facilitatorClient: StellarFacilitatorClient;

    beforeEach(async () => {
      const stellarClient = new ExactStellarClient(clientSigner);
      client = new x402Client().register(STELLAR_TESTNET_CAIP2, stellarClient);

      const stellarFacilitator = new ExactStellarFacilitator([facilitatorSigner]);
      const facilitator = new x402Facilitator().register(STELLAR_TESTNET_CAIP2, stellarFacilitator);

      facilitatorClient = new StellarFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);
      server.register(STELLAR_TESTNET_CAIP2, new ExactStellarServer());
      await server.initialize();
    });

    it("server should successfully verify and settle a Stellar payment from a client", async () => {
      // Server - builds PaymentRequired response
      const accepts = [buildStellarPaymentRequirements(RESOURCE_SERVER_ADDRESS, "1000")];
      const resource = {
        url: "https://company.co",
        description: "Company Co. resource",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      // Client - responds with PaymentPayload response
      let paymentPayload: PaymentPayload;
      try {
        paymentPayload = await client.createPaymentPayload(paymentRequired);
      } catch (error) {
        if (isInsufficientBalanceError(error)) {
          throw new Error(
            `Insufficient balance on testnet account ${clientAddress}. ` +
              `Asset: ${XLM_TESTNET_ASSET}. Ensure the account is funded (e.g. via Friendbot).`,
          );
        }
        throw error;
      }

      expect(paymentPayload).toBeDefined();
      expect(paymentPayload.x402Version).toBe(2);
      expect(paymentPayload.accepted.scheme).toBe("exact");

      // Verify the payload structure
      const stellarPayload = paymentPayload.payload as ExactStellarPayloadV2;
      expect(stellarPayload.transaction).toBeDefined();
      expect(typeof stellarPayload.transaction).toBe("string");
      expect(stellarPayload.transaction.length).toBeGreaterThan(0);

      // Server - maps payment payload to payment requirements
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);

      expect(verifyResponse.isValid).toBe(true);
      expect(verifyResponse.payer).toBe(clientAddress);

      // Server does work here
      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.network).toBe(STELLAR_TESTNET_CAIP2);
      expect(settleResponse.transaction).toBeDefined();
      expect(settleResponse.payer).toBe(clientAddress);
      logStellarExpertTxUrl(settleResponse.transaction);
    });
  });

  describe("x402HTTPClient / x402HTTPResourceServer / x402Facilitator - Stellar Flow", () => {
    let client: x402HTTPClient;
    let httpServer: x402HTTPResourceServer;

    const routes = {
      "/api/protected": {
        accepts: {
          scheme: "exact",
          payTo: RESOURCE_SERVER_ADDRESS,
          price: { amount: "1000", asset: XLM_TESTNET_ASSET },
          network: STELLAR_TESTNET_CAIP2 as Network,
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
      const stellarFacilitator = new ExactStellarFacilitator([facilitatorSigner]);
      const facilitator = new x402Facilitator().register(STELLAR_TESTNET_CAIP2, stellarFacilitator);

      const facilitatorClient = new StellarFacilitatorClient(facilitator);

      const stellarClient = new ExactStellarClient(clientSigner);
      const paymentClient = new x402Client().register(STELLAR_TESTNET_CAIP2, stellarClient);
      client = new x402HTTPClient(paymentClient) as x402HTTPClient;

      // Create resource server and register schemes (composition pattern)
      const ResourceServer = new x402ResourceServer(facilitatorClient);
      ResourceServer.register(STELLAR_TESTNET_CAIP2, new ExactStellarServer());
      await ResourceServer.initialize(); // Initialize to fetch supported kinds

      httpServer = new x402HTTPResourceServer(ResourceServer, routes);
    });

    it("middleware should successfully verify and settle a Stellar payment from an http client", async () => {
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
      let paymentPayload: PaymentPayload;
      try {
        paymentPayload = await client.createPaymentPayload(paymentRequired);
      } catch (error) {
        if (isInsufficientBalanceError(error)) {
          throw new Error(
            `Insufficient balance on testnet account ${clientAddress}. ` +
              `Asset: ${XLM_TESTNET_ASSET}. Ensure the account is funded (e.g. via Friendbot).`,
          );
        }
        throw error;
      }

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
      );

      expect(settlementResult).toBeDefined();
      expect(settlementResult.success).toBe(true);

      if (settlementResult.success) {
        expect(settlementResult.headers).toBeDefined();
        expect(settlementResult.headers["PAYMENT-RESPONSE"]).toBeDefined();
        logStellarExpertTxUrl(settlementResult.transaction);
      }
    });
  });

  describe("Price Parsing Integration", () => {
    let server: x402ResourceServer;
    let stellarServer: ExactStellarServer;

    beforeEach(async () => {
      const facilitator = new x402Facilitator().register(
        STELLAR_TESTNET_CAIP2,
        new ExactStellarFacilitator([facilitatorSigner]),
      );

      const facilitatorClient = new StellarFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);

      stellarServer = new ExactStellarServer();
      server.register(STELLAR_TESTNET_CAIP2, stellarServer);
      await server.initialize();
    });

    it("should parse Money formats and build payment requirements", async () => {
      stellarServer.registerMoneyParser(xlmFallbackParser);

      // Test different Money formats
      const testCases = [
        { input: "$1.00", expectedAmount: "10000000" },
        { input: "1.50", expectedAmount: "15000000" },
        { input: 2.5, expectedAmount: "25000000" },
      ];

      for (const testCase of testCases) {
        const requirements = await server.buildPaymentRequirements({
          scheme: "exact",
          payTo: RESOURCE_SERVER_ADDRESS,
          price: testCase.input,
          network: STELLAR_TESTNET_CAIP2 as Network,
        });

        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(testCase.expectedAmount);
        expect(requirements[0].asset).toBe(XLM_TESTNET_ASSET);
      }
    });

    it("should handle AssetAmount pass-through", async () => {
      const customAsset = {
        amount: "50000000",
        asset: "CUSTOMTOKENMINT111111111111111111111111111111",
        extra: { foo: "bar" },
      };

      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: RESOURCE_SERVER_ADDRESS,
        price: customAsset,
        network: STELLAR_TESTNET_CAIP2 as Network,
      });

      expect(requirements).toHaveLength(1);
      expect(requirements[0].amount).toBe("50000000");
      expect(requirements[0].asset).toBe("CUSTOMTOKENMINT111111111111111111111111111111");
      expect(requirements[0].extra?.foo).toBe("bar");
    });

    it("should use registerMoneyParser for custom conversion", async () => {
      stellarServer
        .registerMoneyParser(async (amount, _network) => {
          if (amount > 100) {
            return {
              amount: (amount * 1e7).toString(),
              asset: "CUSTOMLARGETOKENMINT111111111111111111111",
              extra: { token: "CUSTOM", tier: "large" },
            };
          }
          return null;
        })
        .registerMoneyParser(xlmFallbackParser);

      // Test large amount - should use custom parser
      const largeRequirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: RESOURCE_SERVER_ADDRESS,
        price: 150, // Large amount
        network: STELLAR_TESTNET_CAIP2 as Network,
      });

      expect(largeRequirements[0].amount).toBe((150 * 1e7).toString());
      expect(largeRequirements[0].asset).toBe("CUSTOMLARGETOKENMINT111111111111111111111");
      expect(largeRequirements[0].extra?.token).toBe("CUSTOM");
      expect(largeRequirements[0].extra?.tier).toBe("large");

      // Test small amount - should use default (XLM)
      const smallRequirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: RESOURCE_SERVER_ADDRESS,
        price: 50, // Small amount
        network: STELLAR_TESTNET_CAIP2 as Network,
      });

      expect(smallRequirements[0].amount).toBe("500000000"); // 50 * 1e7 (7 decimals)
      expect(smallRequirements[0].asset).toBe(XLM_TESTNET_ASSET);
    });

    it("should support multiple MoneyParser in chain", async () => {
      stellarServer
        .registerMoneyParser(async amount => {
          if (amount > 1000) {
            return {
              amount: (amount * 1e7).toString(),
              asset: "VIPTOKENMINT111111111111111111111111111111",
              extra: { tier: "vip" },
            };
          }
          return null;
        })
        .registerMoneyParser(async amount => {
          if (amount > 100) {
            return {
              amount: (amount * 1e7).toString(),
              asset: "PREMIUMTOKENMINT1111111111111111111111111",
              extra: { tier: "premium" },
            };
          }
          return null;
        })
        .registerMoneyParser(xlmFallbackParser);
      // < 100 uses XLM fallback

      // VIP tier
      const vipReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: RESOURCE_SERVER_ADDRESS,
        price: 2000,
        network: STELLAR_TESTNET_CAIP2 as Network,
      });
      expect(vipReq[0].extra?.tier).toBe("vip");
      expect(vipReq[0].asset).toBe("VIPTOKENMINT111111111111111111111111111111");

      // Premium tier
      const premiumReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: RESOURCE_SERVER_ADDRESS,
        price: 500,
        network: STELLAR_TESTNET_CAIP2 as Network,
      });
      expect(premiumReq[0].extra?.tier).toBe("premium");
      expect(premiumReq[0].asset).toBe("PREMIUMTOKENMINT1111111111111111111111111");

      // Standard tier (default)
      const standardReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: RESOURCE_SERVER_ADDRESS,
        price: 50,
        network: STELLAR_TESTNET_CAIP2 as Network,
      });
      expect(standardReq[0].asset).toBe(XLM_TESTNET_ASSET);
    });

    it("should work with async MoneyParser (e.g., exchange rate lookup)", async () => {
      const mockExchangeRate = 0.98;

      stellarServer.registerMoneyParser(async (amount, _network) => {
        await new Promise(resolve => setTimeout(resolve, 10));

        const convertedAmount = amount * mockExchangeRate;
        return {
          amount: Math.floor(convertedAmount * 1e7).toString(),
          asset: XLM_TESTNET_ASSET,
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
        network: STELLAR_TESTNET_CAIP2 as Network,
      });

      // 100 * 0.98 = 98 (XLM, 7 decimals)
      expect(requirements[0].amount).toBe("980000000");
      expect(requirements[0].extra?.exchangeRate).toBe(0.98);
      expect(requirements[0].extra?.originalUSD).toBe(100);
    });

    it("should avoid floating-point rounding error", async () => {
      stellarServer.registerMoneyParser(xlmFallbackParser);

      // Test different Money formats
      const testCases = [
        { input: "$4.02", expectedAmount: "40200000" },
        { input: "4.02", expectedAmount: "40200000" },
        { input: "4.02 XLM", expectedAmount: "40200000" },
        { input: "4.02 USD", expectedAmount: "40200000" },
        { input: 4.02, expectedAmount: "40200000" },
      ];

      for (const testCase of testCases) {
        const requirements = await server.buildPaymentRequirements({
          scheme: "exact",
          payTo: RESOURCE_SERVER_ADDRESS,
          price: testCase.input,
          network: STELLAR_TESTNET_CAIP2 as Network,
        });

        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(testCase.expectedAmount);
        expect(requirements[0].asset).toBe(XLM_TESTNET_ASSET);
      }
    });
  });
});
