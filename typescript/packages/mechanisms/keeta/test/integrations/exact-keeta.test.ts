import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as KeetaNet from "@keetanetwork/keetanet-client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  HTTPAdapter,
  HTTPResponseInstructions,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
} from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { ExactKeetaScheme as ExactKeetaClient } from "../../src/exact/client/scheme";
import { ExactKeetaScheme as ExactKeetaFacilitator } from "../../src/exact/facilitator/scheme";
import { ExactKeetaScheme as ExactKeetaServer } from "../../src/exact/server/scheme";
import { toClientKeetaSigner, toFacilitatorKeetaSigner } from "../../src/signer";
import type { ExactKeetaPayload } from "../../src/types";
import { KEETA_MAINNET_CAIP2, KEETA_TESTNET_CAIP2 } from "../../src/constants";
import { getUsdcAddress, KTA_TESTNET_ADDRESS } from "../../src/utils";

// Load mnemonics from environment (all optional, ephemeral accounts are generated if absent)
const CLIENT_MNEMONIC = process.env.KEETA_CLIENT_MNEMONIC;
const FACILITATOR_MNEMONIC = process.env.KEETA_FACILITATOR_MNEMONIC;
const SERVER_ADDRESS = process.env.KEETA_SERVER_ADDRESS;

// Amount: 0.000001 KTA in atomic units (Testnet KTA has 9 decimals)
const PAYMENT_AMOUNT = "1000";

async function ensureAccountFunded(
  accountAddress: string,
  minBalance: bigint = 50000n,
): Promise<void> {
  await using tempClient = KeetaNet.UserClient.fromNetwork("test", null);
  const initialBalance = await tempClient.client.getBalance(accountAddress, tempClient.baseToken);

  if (initialBalance >= minBalance) {
    return;
  }

  console.log(
    `Balance ${initialBalance} < ${minBalance} for ${accountAddress}, requesting faucet tokens...`,
  );

  const params = new URLSearchParams();
  params.append("address", accountAddress);
  // Request 1 KTA at a time
  params.append("amount", "1");

  try {
    const response = await fetch("https://faucet.test.keeta.com", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (response.ok) {
      console.log(`Requested faucet tokens for ${accountAddress}`);
    } else {
      console.warn(`Faucet request failed for ${accountAddress}: ${response.status}`);
      return;
    }
  } catch (error) {
    console.warn(`Faucet request error for ${accountAddress}:`, error);
    return;
  }

  let funded = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const balance = await tempClient.client.getBalance(accountAddress, tempClient.baseToken);
    if (balance >= minBalance) {
      funded = true;
      break;
    }
    await KeetaNet.lib.Utils.Helper.asleep(500);
  }

  if (!funded) {
    console.warn(
      `Account ${accountAddress} balance may still be below ${minBalance} after faucet request`,
    );
  }
}

/**
 * Keeta Facilitator Client wrapper.
 * Wraps the x402Facilitator for use with x402ResourceServer.
 */
class KeetaFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = KEETA_TESTNET_CAIP2;
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

/**
 * Build Keeta payment requirements for testing.
 */
function buildKeetaPaymentRequirements(
  payTo: string,
  asset: string,
  amount: string,
  network: Network = KEETA_TESTNET_CAIP2,
): PaymentRequirements {
  return {
    scheme: "exact",
    network,
    asset: asset,
    amount,
    payTo,
    maxTimeoutSeconds: 60,
    extra: {},
  };
}

describe("Keeta Integration Tests", () => {
  let clientAccount: InstanceType<typeof KeetaNet.lib.Account>;
  let facilitatorAccount: InstanceType<typeof KeetaNet.lib.Account>;
  let serverAddress: string;
  let usdcTestnetAddress: string;
  let usdcMainnetAddress: string;

  beforeAll(async () => {
    // Create client account: use mnemonic if provided, otherwise generate a fresh ephemeral account
    clientAccount = KeetaNet.lib.Account.fromSeed(
      CLIENT_MNEMONIC
        ? await KeetaNet.lib.Account.seedFromPassphrase(CLIENT_MNEMONIC)
        : KeetaNet.lib.Account.generateRandomSeed({ asString: true }),
      0,
    );

    // Create facilitator account: use mnemonic if provided, otherwise generate a fresh ephemeral account
    facilitatorAccount = KeetaNet.lib.Account.fromSeed(
      FACILITATOR_MNEMONIC
        ? await KeetaNet.lib.Account.seedFromPassphrase(FACILITATOR_MNEMONIC)
        : KeetaNet.lib.Account.generateRandomSeed({ asString: true }),
      0,
    );

    // Derive server address: use env var if provided, otherwise generate a fresh ephemeral account
    serverAddress = SERVER_ADDRESS
      ? SERVER_ADDRESS
      : KeetaNet.lib.Account.fromSeed(
          KeetaNet.lib.Account.generateRandomSeed({ asString: true }),
          0,
        ).publicKeyString.toString();

    // Ensure both accounts have enough KTA before any test runs
    await Promise.all([
      ensureAccountFunded(clientAccount.publicKeyString.toString()),
      ensureAccountFunded(facilitatorAccount.publicKeyString.toString()),
    ]);

    [usdcTestnetAddress, usdcMainnetAddress] = await Promise.all([
      await getUsdcAddress(KEETA_TESTNET_CAIP2),
      await getUsdcAddress(KEETA_MAINNET_CAIP2),
    ]);
  }, 60000); // Allow up to 60s for faucet funding to confirm

  describe("x402Client / x402ResourceServer / x402Facilitator - Keeta Flow", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let clientAddress: string;
    let facilitatorAddress: string;

    beforeEach(async () => {
      // Use the module-level accounts created in beforeAll
      clientAddress = clientAccount.publicKeyString.toString();
      const clientSigner = toClientKeetaSigner(clientAccount);
      const keetaClientScheme = new ExactKeetaClient(clientSigner);
      client = new x402Client().register(KEETA_TESTNET_CAIP2, keetaClientScheme);

      facilitatorAddress = facilitatorAccount.publicKeyString.toString();
      const facilitatorSigner = toFacilitatorKeetaSigner([facilitatorAccount]);

      const keetaFacilitatorScheme = new ExactKeetaFacilitator(facilitatorSigner);
      const facilitator = new x402Facilitator().register(
        KEETA_TESTNET_CAIP2,
        keetaFacilitatorScheme,
      );

      const facilitatorClient = new KeetaFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);
      server.register(KEETA_TESTNET_CAIP2, new ExactKeetaServer());
      await server.initialize();
    });

    it("server should successfully verify a Keeta payment from a client", async () => {
      const accepts = [
        buildKeetaPaymentRequirements(serverAddress, KTA_TESTNET_ADDRESS, PAYMENT_AMOUNT),
      ];
      const resource = {
        url: "https://example.com/api",
        description: "Test protected resource",
        mimeType: "application/json",
      };

      // Server builds PaymentRequired response
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      // Client creates PaymentPayload
      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      expect(paymentPayload).toBeDefined();
      expect(paymentPayload.x402Version).toBe(2);
      expect(paymentPayload.accepted.scheme).toBe("exact");
      expect(paymentPayload.accepted.network).toBe(KEETA_TESTNET_CAIP2);

      // Verify the payload structure
      const keetaPayload = paymentPayload.payload as ExactKeetaPayload;
      expect(keetaPayload.block).toBeDefined();
      expect(typeof keetaPayload.block).toBe("string");

      // Server verifies the payment payload
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);

      if (!verifyResponse.isValid) {
        console.error("Verification failed:", verifyResponse.invalidReason);
        console.error("Payer:", verifyResponse.payer);
        console.error("Client address:", clientAddress);
      }

      expect(verifyResponse.isValid).toBe(true);
      expect(verifyResponse.payer).toBe(clientAddress);
    });

    it("facilitator should settle a valid Keeta payment and return block hash", async () => {
      const accepts = [
        buildKeetaPaymentRequirements(serverAddress, KTA_TESTNET_ADDRESS, PAYMENT_AMOUNT),
      ];
      const resource = {
        url: "https://example.com/api",
        description: "Test protected resource",
        mimeType: "application/json",
      };

      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);

      if (!settleResponse.success) {
        console.error("Settlement failed:", settleResponse.errorReason);
      }

      expect(settleResponse.success).toBe(true);
      expect(settleResponse.transaction).toBeDefined();
      expect(typeof settleResponse.transaction).toBe("string");
      expect(settleResponse.transaction.length).toBeGreaterThan(0);
      expect(settleResponse.network).toBe(KEETA_TESTNET_CAIP2);
      expect(settleResponse.payer).toBe(clientAddress);
    }, 10000);

    it("server should generate valid payment requirements with correct USDC asset", async () => {
      const server = new ExactKeetaServer();
      const result = await server.parsePrice("$1.00", KEETA_TESTNET_CAIP2);

      expect(result.amount).toBe("1000000");
      expect(result.asset).toBe(usdcTestnetAddress);
    });

    it("client should fail to verify a payment with wrong amount", async () => {
      // Build requirements requesting more than what client pays
      const wrongAmountRequirements = [
        buildKeetaPaymentRequirements(serverAddress, KTA_TESTNET_ADDRESS, "9999999999"),
      ];
      const resource = {
        url: "https://example.com/api",
        description: "Test resource",
        mimeType: "application/json",
      };

      const paymentRequired = await server.createPaymentRequiredResponse(
        wrongAmountRequirements,
        resource,
      );

      // Client creates payload for the wrong amount, then we verify against a different amount
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(wrongAmountRequirements, paymentPayload);

      // The block contains the amount from the requirements, so this should succeed
      // But if we manually change the requirements amount, it should fail
      const tamperedRequirements = {
        ...accepted!,
        // Much less than what was requested
        amount: "1",
      };

      const verifyResponse = await server.verifyPayment(paymentPayload, tamperedRequirements);
      // The block was created for the original amount, not "1", so verification should fail
      expect(verifyResponse.isValid).toBe(false);
      expect(verifyResponse.invalidReason).toBe(
        "invalid_exact_keeta_payload_payment_amount_mismatch",
      );
    });

    it("facilitator should reject a payment with a mismatched payTo address", async () => {
      const accepts = [
        buildKeetaPaymentRequirements(serverAddress, KTA_TESTNET_ADDRESS, PAYMENT_AMOUNT),
      ];
      const resource = {
        url: "https://example.com/api",
        description: "Test resource",
        mimeType: "application/json",
      };

      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);

      // Tamper with payTo to make it a different address
      const tamperedRequirements = {
        ...accepted!,
        // Different from what client signed for
        payTo: facilitatorAddress,
      };

      const verifyResponse = await server.verifyPayment(paymentPayload, tamperedRequirements);
      expect(verifyResponse.isValid).toBe(false);
      expect(verifyResponse.invalidReason).toBe("invalid_exact_keeta_payload_payment_to_mismatch");
    });
  });

  describe("x402HTTPClient / x402HTTPResourceServer / x402Facilitator - Keeta Flow", () => {
    let httpClient: x402HTTPClient;
    let httpServer: x402HTTPResourceServer;

    const mockAdapter: HTTPAdapter = {
      getHeader: () => undefined,
      getMethod: () => "GET",
      getPath: () => "/api/protected",
      getUrl: () => "https://example.com/api/protected",
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "TestClient/1.0",
    };

    beforeEach(async () => {
      const routes = {
        "/api/protected": {
          accepts: {
            scheme: "exact",
            payTo: serverAddress,
            // Use testnet KTA as an AssetAmount so the client can pay
            price: { amount: PAYMENT_AMOUNT, asset: KTA_TESTNET_ADDRESS },
            network: KEETA_TESTNET_CAIP2 as Network,
          },
          description: "Access to protected API",
          mimeType: "application/json",
        },
      };

      const facilitatorSigner = toFacilitatorKeetaSigner([facilitatorAccount]);
      const keetaFacilitatorScheme = new ExactKeetaFacilitator(facilitatorSigner);
      const facilitator = new x402Facilitator().register(
        KEETA_TESTNET_CAIP2,
        keetaFacilitatorScheme,
      );

      const facilitatorClient = new KeetaFacilitatorClient(facilitator);

      const clientSigner = toClientKeetaSigner(clientAccount);
      const keetaClientScheme = new ExactKeetaClient(clientSigner);
      const paymentClient = new x402Client().register(KEETA_TESTNET_CAIP2, keetaClientScheme);
      httpClient = new x402HTTPClient(paymentClient) as x402HTTPClient;

      // Create resource server
      const resourceServer = new x402ResourceServer(facilitatorClient);
      resourceServer.register(KEETA_TESTNET_CAIP2, new ExactKeetaServer());
      await resourceServer.initialize();

      httpServer = new x402HTTPResourceServer(resourceServer, routes);
    });

    it("middleware should successfully verify a Keeta payment from an HTTP client", async () => {
      const context = {
        adapter: mockAdapter,
        path: "/api/protected",
        method: "GET",
      };

      // No payment yet - server responds with 402
      const httpProcessResult = (await httpServer.processHTTPRequest(context))!;

      expect(httpProcessResult.type).toBe("payment-error");

      const initial402Response = (
        httpProcessResult as { type: "payment-error"; response: HTTPResponseInstructions }
      ).response;

      expect(initial402Response).toBeDefined();
      expect(initial402Response.status).toBe(402);
      expect(initial402Response.headers).toBeDefined();
      expect(initial402Response.headers["PAYMENT-REQUIRED"]).toBeDefined();

      // Client parses the 402 and creates a payment payload
      const paymentRequired = httpClient.getPaymentRequiredResponse(
        name => initial402Response.headers[name],
        initial402Response.body,
      );
      const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);

      expect(paymentPayload).toBeDefined();
      expect(paymentPayload.accepted.scheme).toBe("exact");
      expect(paymentPayload.accepted.network).toBe(KEETA_TESTNET_CAIP2);

      // Client encodes the payment signature header
      const requestHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

      // Server processes the request with payment signature
      mockAdapter.getHeader = (name: string) => {
        if (name === "PAYMENT-SIGNATURE") {
          return requestHeaders["PAYMENT-SIGNATURE"];
        }
        return undefined;
      };

      const httpProcessResult2 = await httpServer.processHTTPRequest(context);

      expect(httpProcessResult2.type).toBe("payment-verified");
      const { paymentPayload: verifiedPayload, paymentRequirements: verifiedRequirements } =
        httpProcessResult2 as {
          type: "payment-verified";
          paymentPayload: PaymentPayload;
          paymentRequirements: PaymentRequirements;
        };

      expect(verifiedPayload).toBeDefined();
      expect(verifiedRequirements).toBeDefined();
    });
  });

  describe("Price Parsing Integration", () => {
    let resourceServer: x402ResourceServer;
    let keetaServer: ExactKeetaServer;

    beforeEach(async () => {
      const facilitatorSigner = toFacilitatorKeetaSigner([facilitatorAccount]);
      const facilitator = new x402Facilitator().register(
        KEETA_TESTNET_CAIP2,
        new ExactKeetaFacilitator(facilitatorSigner),
      );

      const facilitatorClient = new KeetaFacilitatorClient(facilitator);
      resourceServer = new x402ResourceServer(facilitatorClient);

      keetaServer = new ExactKeetaServer();
      resourceServer.register(KEETA_TESTNET_CAIP2, keetaServer);
      await resourceServer.initialize();
    });

    it("should parse Money formats and build payment requirements", async () => {
      const testCases = [
        { input: "$1.00", expectedAmount: "1000000" },
        { input: "1.50", expectedAmount: "1500000" },
        { input: 2.5, expectedAmount: "2500000" },
      ];

      for (const testCase of testCases) {
        const requirements = await resourceServer.buildPaymentRequirements({
          scheme: "exact",
          payTo: serverAddress,
          price: testCase.input,
          network: KEETA_TESTNET_CAIP2,
        });

        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(testCase.expectedAmount);
        expect(requirements[0].asset).toBe(usdcTestnetAddress);
      }
    });

    it("should handle AssetAmount pass-through", async () => {
      const customAsset = {
        amount: "5000000",
        asset: usdcTestnetAddress,
        extra: { external: "abc123" },
      };

      const requirements = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        payTo: serverAddress,
        price: customAsset,
        network: KEETA_TESTNET_CAIP2,
      });

      expect(requirements).toHaveLength(1);
      expect(requirements[0].amount).toBe("5000000");
      expect(requirements[0].asset).toBe(usdcTestnetAddress);
      expect(requirements[0].extra?.external).toBe("abc123");
    });

    it("should use registerMoneyParser for custom conversion", async () => {
      // Use mainnet USDC as stand-in (doesn't exist on testnet)
      const CUSTOM_TOKEN = usdcMainnetAddress;
      keetaServer.registerMoneyParser(async (amount, _network) => {
        if (amount > 100) {
          return {
            // 8 decimal token (different from default USDC with 6 decimals)
            amount: String(Math.round(amount * 1e8)),
            asset: CUSTOM_TOKEN,
            extra: { tier: "large" },
          };
        }
        // Fall through to default for small amounts
        return null;
      });

      // Large amount, custom parser takes over
      const largeRequirements = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        payTo: serverAddress,
        price: 150,
        network: KEETA_TESTNET_CAIP2,
      });

      expect(largeRequirements[0].amount).toBe(String(Math.round(150 * 1e8)));
      expect(largeRequirements[0].asset).toBe(CUSTOM_TOKEN);
      expect(largeRequirements[0].extra?.tier).toBe("large");

      // Small amount, falls through to default USDC
      const smallRequirements = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        payTo: serverAddress,
        price: 50,
        network: KEETA_TESTNET_CAIP2,
      });

      expect(smallRequirements[0].amount).toBe("50000000");
      expect(smallRequirements[0].asset).toBe(usdcTestnetAddress);
    });

    it("should support multiple MoneyParsers chained", async () => {
      const TOKEN_A = usdcMainnetAddress;
      const TOKEN_B = usdcTestnetAddress;

      keetaServer
        .registerMoneyParser(async amount => {
          if (amount > 1000) {
            return {
              amount: String(Math.round(amount * 1e8)),
              asset: TOKEN_A,
              extra: { tier: "vip" },
            };
          }
          return null;
        })
        .registerMoneyParser(async amount => {
          if (amount > 100) {
            return {
              amount: String(Math.round(amount * 1e6)),
              asset: TOKEN_B,
              extra: { tier: "premium" },
            };
          }
          return null;
        });

      // Amounts <= 100 use default USDC
      const vipReq = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        payTo: serverAddress,
        price: 2000,
        network: KEETA_TESTNET_CAIP2,
      });
      expect(vipReq[0].extra?.tier).toBe("vip");
      expect(vipReq[0].asset).toBe(TOKEN_A);

      const premiumReq = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        payTo: serverAddress,
        price: 500,
        network: KEETA_TESTNET_CAIP2,
      });
      expect(premiumReq[0].extra?.tier).toBe("premium");
      expect(premiumReq[0].asset).toBe(TOKEN_B);

      const standardReq = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        payTo: serverAddress,
        price: 50,
        network: KEETA_TESTNET_CAIP2,
      });
      expect(standardReq[0].asset).toBe(usdcTestnetAddress);
    });

    it("should avoid floating-point rounding errors", async () => {
      const testCases = [
        { input: "$4.02", expectedAmount: "4020000" },
        { input: "4.02", expectedAmount: "4020000" },
        { input: 4.02, expectedAmount: "4020000" },
      ];

      for (const testCase of testCases) {
        const requirements = await resourceServer.buildPaymentRequirements({
          scheme: "exact",
          payTo: serverAddress,
          price: testCase.input,
          network: KEETA_TESTNET_CAIP2,
        });

        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(testCase.expectedAmount);
        expect(requirements[0].asset).toBe(usdcTestnetAddress);
      }
    });
  });
});
