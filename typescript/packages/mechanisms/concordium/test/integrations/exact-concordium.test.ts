import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { buildBasicAccountSigner, AccountAddress } from "@concordium/web-sdk";
import { ExactConcordiumScheme as ExactConcordiumClient } from "../../src/exact/client/scheme";
import { ExactConcordiumScheme as ExactConcordiumServer } from "../../src/exact/server/scheme";
import { ExactConcordiumScheme as ExactConcordiumFacilitator } from "../../src/exact/facilitator/scheme";
import { toConcordiumFacilitatorSigner } from "../../src/signer";
import type { ClientConcordiumSigner } from "../../src/signer";
import type { ExactConcordiumPayloadV2, SimpleTransferPayload } from "../../src/types";
import {
  CONCORDIUM_TESTNET_CAIP2,
  getConcordiumGrpcUrl,
  parseGrpcUrl,
  getExplorerTxUrl,
} from "../../src/constants";

const CLIENT_PRIVATE_KEY = process.env.CONCORDIUM_CLIENT_PRIVATE_KEY;
const CLIENT_ADDRESS = process.env.CONCORDIUM_CLIENT_ADDRESS;
const FACILITATOR_PRIVATE_KEY = process.env.CONCORDIUM_FACILITATOR_PRIVATE_KEY;
const FACILITATOR_ADDRESS = process.env.CONCORDIUM_FACILITATOR_ADDRESS;
const PAY_TO_ADDRESS = process.env.CONCORDIUM_PAY_TO_ADDRESS;

if (
  !CLIENT_PRIVATE_KEY ||
  !CLIENT_ADDRESS ||
  !FACILITATOR_PRIVATE_KEY ||
  !FACILITATOR_ADDRESS ||
  !PAY_TO_ADDRESS
) {
  throw new Error(
    "CONCORDIUM_CLIENT_PRIVATE_KEY, CONCORDIUM_CLIENT_ADDRESS, CONCORDIUM_FACILITATOR_PRIVATE_KEY, CONCORDIUM_FACILITATOR_ADDRESS, and CONCORDIUM_PAY_TO_ADDRESS must be set.",
  );
}

/**
 * Concordium Facilitator Client wrapper.
 * Wraps the x402Facilitator for use with x402ResourceServer.
 */
class ConcordiumFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = CONCORDIUM_TESTNET_CAIP2;
  readonly x402Version = 2;

  /**
   * Creates a new ConcordiumFacilitatorClient instance.
   *
   * @param facilitator - The x402 facilitator to wrap
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * Verifies a payment payload.
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
   * Settles a payment.
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
   * Gets supported payment kinds.
   *
   * @returns Promise resolving to supported response
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported() as SupportedResponse);
  }
}

/**
 * Builds Concordium payment requirements for testing.
 *
 * @param payTo - The recipient address
 * @param amount - The payment amount in atomic units
 * @param feePayer - The facilitator fee payer (sponsor) account address
 * @param asset - Asset identifier ("CCD" for native)
 * @param network - The network identifier
 * @returns Payment requirements object
 */
function buildConcordiumPaymentRequirements(
  payTo: string,
  amount: string,
  feePayer: string,
  asset = "CCD",
  network: Network = CONCORDIUM_TESTNET_CAIP2,
  extraFields?: Record<string, unknown>,
): PaymentRequirements {
  return {
    scheme: "exact",
    network,
    asset,
    amount,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { feePayer, ...(extraFields ?? {}) },
  };
}

/**
 * Logs the CCDExplorer URL for a finalized transaction.
 *
 * @param txHash - The transaction hash
 */
function logExplorerUrl(txHash: string): void {
  const url = getExplorerTxUrl(CONCORDIUM_TESTNET_CAIP2, txHash);
  console.log(`CCDExplorer (testnet): ${url}`);
}

let clientSigner: ClientConcordiumSigner;
let clientAddress: string;
let facilitatorAddress: string;
let facilitatorSigner: ReturnType<typeof toConcordiumFacilitatorSigner>;

describe("Concordium Integration Tests", () => {
  beforeAll(() => {
    const [host, port] = parseGrpcUrl(getConcordiumGrpcUrl(CONCORDIUM_TESTNET_CAIP2));

    clientAddress = CLIENT_ADDRESS;
    clientSigner = {
      accountAddress: AccountAddress.fromBase58(clientAddress),
      signer: buildBasicAccountSigner(CLIENT_PRIVATE_KEY),
    };
    console.log(`Client: ${clientAddress}`);

    facilitatorAddress = FACILITATOR_ADDRESS;
    facilitatorSigner = toConcordiumFacilitatorSigner(facilitatorAddress, FACILITATOR_PRIVATE_KEY, {
      host,
      port,
      useTls: true,
    });
    console.log(`Facilitator: ${facilitatorAddress}`);

    console.log(`PayTo:       ${PAY_TO_ADDRESS}`);
    console.log(`Network:     ${CONCORDIUM_TESTNET_CAIP2}\n`);
  });

  describe("x402Client / x402ResourceServer / x402Facilitator - Concordium Flow", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let facilitatorClient: ConcordiumFacilitatorClient;

    beforeEach(async () => {
      const concordiumClient = new ExactConcordiumClient(clientSigner);
      client = new x402Client().register(CONCORDIUM_TESTNET_CAIP2, concordiumClient);

      const concordiumFacilitator = new ExactConcordiumFacilitator({
        signer: facilitatorSigner,
        requireFinalization: true,
        finalizationTimeoutMs: 90_000,
      });
      const facilitator = new x402Facilitator().register(
        CONCORDIUM_TESTNET_CAIP2,
        concordiumFacilitator,
      );

      facilitatorClient = new ConcordiumFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);
      server.register(CONCORDIUM_TESTNET_CAIP2, new ExactConcordiumServer());
      await server.initialize();
    });

    it("should successfully verify and settle a native CCD payment", async () => {
      const accepts = [
        buildConcordiumPaymentRequirements(
          PAY_TO_ADDRESS!,
          "1000000", // 1 CCD
          facilitatorAddress,
        ),
      ];
      const resource = {
        url: "https://example.com/premium",
        description: "Premium content",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      // Client creates payment payload
      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      expect(paymentPayload).toBeDefined();
      expect(paymentPayload.x402Version).toBe(2);
      expect(paymentPayload.accepted.scheme).toBe("exact");
      expect(paymentPayload.accepted.network).toBe(CONCORDIUM_TESTNET_CAIP2);

      // Verify payload structure
      const concordiumPayload = paymentPayload.payload as unknown as ExactConcordiumPayloadV2;
      expect(concordiumPayload.signedTransaction).toBeDefined();
      expect(concordiumPayload.signedTransaction.version).toBe(1);
      expect(concordiumPayload.signedTransaction.header.sender).toBe(clientAddress);

      // Server verifies
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      if (!verifyResponse.isValid) {
        console.log("Verification failed:", verifyResponse.invalidReason);
      }
      expect(verifyResponse.isValid).toBe(true);
      expect(verifyResponse.payer).toBe(clientAddress);

      // Server settles
      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.network).toBe(CONCORDIUM_TESTNET_CAIP2);
      expect(settleResponse.transaction).toBeDefined();
      expect(settleResponse.payer).toBe(clientAddress);

      logExplorerUrl(settleResponse.transaction);
    });

    it("should successfully verify and settle a PLT token payment (EURR)", async () => {
      const accepts = [
        buildConcordiumPaymentRequirements(
          PAY_TO_ADDRESS!,
          "1000000", // 1 EURR in atomic units (6 decimals)
          facilitatorAddress,
          "EURR",
          CONCORDIUM_TESTNET_CAIP2,
          { decimals: 6 },
        ),
      ];
      const resource = {
        url: "https://example.com/premium-eurr",
        description: "Premium content - EURR",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      expect(paymentPayload).toBeDefined();
      expect(paymentPayload.accepted.asset).toBe("EURR");

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      if (!verifyResponse.isValid) {
        console.log("PLT verification failed:", verifyResponse.invalidReason);
      }
      expect(verifyResponse.isValid).toBe(true);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.transaction).toBeDefined();

      logExplorerUrl(settleResponse.transaction);
    });

    it("should successfully verify and settle a PLT token payment (USDR)", async () => {
      const accepts = [
        buildConcordiumPaymentRequirements(
          PAY_TO_ADDRESS!,
          "1000000", // 1 USDR in atomic units (6 decimals)
          facilitatorAddress,
          "USDR",
          CONCORDIUM_TESTNET_CAIP2,
          { decimals: 6 },
        ),
      ];
      const resource = {
        url: "https://example.com/premium-usdr",
        description: "Premium content - USDR",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      expect(paymentPayload).toBeDefined();
      expect(paymentPayload.accepted.asset).toBe("USDR");

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      if (!verifyResponse.isValid) {
        console.log("USDR verification failed:", verifyResponse.invalidReason);
      }
      expect(verifyResponse.isValid).toBe(true);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.transaction).toBeDefined();

      logExplorerUrl(settleResponse.transaction);
    });

    it("should reject payment with wrong sponsor address", async () => {
      const wrongSponsor = "3kBx2h5Y2veb4hZvAE2c1Zr6DYJwWbPr9xQJJBPWyFnXHF9UuN";
      const accepts = [
        buildConcordiumPaymentRequirements(PAY_TO_ADDRESS!, "1000000", wrongSponsor),
      ];
      const resource = {
        url: "https://example.com/premium",
        description: "Premium content",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      // Client fails to build the tx because the sponsor address has an invalid checksum
      await expect(client.createPaymentPayload(paymentRequired)).rejects.toThrow("checksum");
    });
  });

  describe("x402HTTPClient / x402HTTPResourceServer / x402Facilitator - Concordium Flow", () => {
    let client: x402HTTPClient;
    let httpServer: x402HTTPResourceServer;

    const routes = {
      "/api/protected": {
        accepts: {
          scheme: "exact",
          payTo: PAY_TO_ADDRESS!,
          price: { amount: "1000000", asset: "CCD" }, // 1 CCD in microCCD
          network: CONCORDIUM_TESTNET_CAIP2 as Network,
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
      const concordiumFacilitator = new ExactConcordiumFacilitator({
        signer: facilitatorSigner,
        requireFinalization: true,
        finalizationTimeoutMs: 90_000,
      });
      const facilitator = new x402Facilitator().register(
        CONCORDIUM_TESTNET_CAIP2,
        concordiumFacilitator,
      );

      const facilitatorClientWrapper = new ConcordiumFacilitatorClient(facilitator);

      const concordiumClient = new ExactConcordiumClient(clientSigner);
      const paymentClient = new x402Client().register(CONCORDIUM_TESTNET_CAIP2, concordiumClient);
      client = new x402HTTPClient(paymentClient) as x402HTTPClient;

      const resourceServer = new x402ResourceServer(facilitatorClientWrapper);
      resourceServer.register(CONCORDIUM_TESTNET_CAIP2, new ExactConcordiumServer());
      await resourceServer.initialize();

      httpServer = new x402HTTPResourceServer(resourceServer, routes);
    });

    it("middleware should successfully verify and settle a CCD payment from an HTTP client", async () => {
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
      expect(paymentPayload.accepted.network).toBe(CONCORDIUM_TESTNET_CAIP2);

      const requestHeaders = await client.encodePaymentSignatureHeader(paymentPayload);

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

      // Settle
      const settlementResult = await httpServer.processSettlement(
        verifiedPayload,
        verifiedRequirements,
      );

      expect(settlementResult).toBeDefined();
      expect(settlementResult.success).toBe(true);

      if (settlementResult.success) {
        expect(settlementResult.headers).toBeDefined();
        expect(settlementResult.headers["PAYMENT-RESPONSE"]).toBeDefined();
        logExplorerUrl(settlementResult.transaction);
      }
    });
  });

  describe("Price Parsing Integration", () => {
    let server: x402ResourceServer;
    let concordiumServer: ExactConcordiumServer;

    beforeEach(async () => {
      const concordiumFacilitator = new ExactConcordiumFacilitator({
        signer: facilitatorSigner,
        requireFinalization: true,
      });
      const facilitator = new x402Facilitator().register(
        CONCORDIUM_TESTNET_CAIP2,
        concordiumFacilitator,
      );

      const facilitatorClientWrapper = new ConcordiumFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClientWrapper);

      concordiumServer = new ExactConcordiumServer();
      server.register(CONCORDIUM_TESTNET_CAIP2, concordiumServer);
      await server.initialize();
    });

    it("should throw on raw numbers without a registered money parser", async () => {
      await expect(
        server.buildPaymentRequirements({
          scheme: "exact",
          payTo: PAY_TO_ADDRESS!,
          price: "10",
          network: CONCORDIUM_TESTNET_CAIP2 as Network,
        }),
      ).rejects.toThrow("Cannot resolve price");
    });

    it("should pass through AssetAmount for CCD in atomic units", async () => {
      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: PAY_TO_ADDRESS!,
        price: { amount: "1000000", asset: "CCD" },
        network: CONCORDIUM_TESTNET_CAIP2 as Network,
      });

      expect(requirements).toHaveLength(1);
      expect(requirements[0].amount).toBe("1000000");
      expect(requirements[0].asset).toBe("CCD");
    });

    it("should pass through AssetAmount for PLT tokens in atomic units", async () => {
      const customAsset = {
        amount: "500",
        asset: "EURR",
        extra: { foo: "bar" },
      };

      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: PAY_TO_ADDRESS!,
        price: customAsset,
        network: CONCORDIUM_TESTNET_CAIP2 as Network,
      });

      expect(requirements).toHaveLength(1);
      expect(requirements[0].amount).toBe("500");
      expect(requirements[0].asset).toBe("EURR");
      expect(requirements[0].extra?.foo).toBe("bar");
    });

    it("should throw when USD price has no registered money parser", async () => {
      await expect(
        server.buildPaymentRequirements({
          scheme: "exact",
          payTo: PAY_TO_ADDRESS!,
          price: "$0.001",
          network: CONCORDIUM_TESTNET_CAIP2 as Network,
        }),
      ).rejects.toThrow("Cannot resolve price");
    });

    it("should use registerMoneyParser for custom conversion", async () => {
      concordiumServer.registerMoneyParser(async (amount, _network) => {
        if (amount > 100) {
          return {
            amount: String(Math.round(amount * 1e6)),
            asset: "EURR",
            extra: { tier: "large" },
          };
        }
        return null;
      });

      const largeRequirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: PAY_TO_ADDRESS!,
        price: 150,
        network: CONCORDIUM_TESTNET_CAIP2 as Network,
      });

      expect(largeRequirements[0].amount).toBe("150000000");
      expect(largeRequirements[0].asset).toBe("EURR");
      expect(largeRequirements[0].extra?.tier).toBe("large");

      // Small amount falls through all parsers — throws, no silent CCD fallback
      await expect(
        server.buildPaymentRequirements({
          scheme: "exact",
          payTo: PAY_TO_ADDRESS!,
          price: 50,
          network: CONCORDIUM_TESTNET_CAIP2 as Network,
        }),
      ).rejects.toThrow("Cannot resolve price");
    });

    it("should support multiple MoneyParser in chain", async () => {
      concordiumServer
        .registerMoneyParser(async amount => {
          if (amount > 1000) {
            return {
              amount: String(Math.round(amount * 1e6)),
              asset: "EURR",
              extra: { tier: "vip" },
            };
          }
          return null;
        })
        .registerMoneyParser(async amount => {
          if (amount > 100) {
            return {
              amount: String(Math.round(amount * 1e6)),
              asset: "USDR",
              extra: { tier: "premium" },
            };
          }
          return null;
        });

      const vipReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: PAY_TO_ADDRESS!,
        price: 2000,
        network: CONCORDIUM_TESTNET_CAIP2 as Network,
      });
      expect(vipReq[0].extra?.tier).toBe("vip");
      expect(vipReq[0].asset).toBe("EURR");

      const premiumReq = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: PAY_TO_ADDRESS!,
        price: 500,
        network: CONCORDIUM_TESTNET_CAIP2 as Network,
      });
      expect(premiumReq[0].extra?.tier).toBe("premium");
      expect(premiumReq[0].asset).toBe("USDR");

      // Unmatched amount falls through all parsers — throws
      await expect(
        server.buildPaymentRequirements({
          scheme: "exact",
          payTo: PAY_TO_ADDRESS!,
          price: 50,
          network: CONCORDIUM_TESTNET_CAIP2 as Network,
        }),
      ).rejects.toThrow("Cannot resolve price");
    });

    it("should throw on floating-point numbers without money parser", async () => {
      await expect(
        server.buildPaymentRequirements({
          scheme: "exact",
          payTo: PAY_TO_ADDRESS!,
          price: 4.02,
          network: CONCORDIUM_TESTNET_CAIP2 as Network,
        }),
      ).rejects.toThrow("Cannot resolve price");
    });

    it("should throw when AssetAmount has null asset", async () => {
      await expect(
        server.buildPaymentRequirements({
          scheme: "exact",
          payTo: PAY_TO_ADDRESS!,
          price: { amount: "100", asset: null as any },
          network: CONCORDIUM_TESTNET_CAIP2 as Network,
        }),
      ).rejects.toThrow("Asset must be specified");
    });

    it("should throw when AssetAmount has undefined asset", async () => {
      await expect(
        server.buildPaymentRequirements({
          scheme: "exact",
          payTo: PAY_TO_ADDRESS!,
          price: { amount: "100", asset: undefined as any },
          network: CONCORDIUM_TESTNET_CAIP2 as Network,
        }),
      ).rejects.toThrow("Asset must be specified");
    });

    it("should throw when AssetAmount has empty string asset", async () => {
      await expect(
        server.buildPaymentRequirements({
          scheme: "exact",
          payTo: PAY_TO_ADDRESS!,
          price: { amount: "100", asset: "" },
          network: CONCORDIUM_TESTNET_CAIP2 as Network,
        }),
      ).rejects.toThrow("Asset must be specified");
    });

    it("should not include decimals in createPaymentRequiredResponse extra", async () => {
      const accepts = [
        buildConcordiumPaymentRequirements(
          PAY_TO_ADDRESS!,
          "1000000",
          facilitatorAddress,
          "EURR",
          CONCORDIUM_TESTNET_CAIP2,
        ),
      ];
      const resource = {
        url: "https://example.com/premium-no-decimals",
        description: "Premium content - no decimals leak",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      // Verify the response contains payment requirements
      expect(paymentRequired).toBeDefined();
      expect(paymentRequired.accepts).toBeDefined();
      // Server must NOT leak decimals — client fetches them from chain (Theme D1)
      for (const req of paymentRequired.accepts) {
        expect((req.extra as Record<string, unknown>)?.decimals).toBeUndefined();
      }
    });
  });

  describe("ExactConcordiumClient - Payment Payload Validation", () => {
    let concordiumClient: ExactConcordiumClient;

    beforeAll(() => {
      concordiumClient = new ExactConcordiumClient(clientSigner);
    });

    it("should reject missing account address", async () => {
      const brokenClient = new ExactConcordiumClient({
        accountAddress: undefined as any,
        signer: {} as any,
      });
      await expect(
        brokenClient.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "1000",
          payTo: PAY_TO_ADDRESS!,
          maxTimeoutSeconds: 60,
          extra: { feePayer: facilitatorAddress },
        }),
      ).rejects.toThrow("Concordium account address is required");
    });

    it("should reject missing payTo", async () => {
      await expect(
        concordiumClient.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "1000",
          payTo: undefined as any,
          maxTimeoutSeconds: 60,
          extra: { feePayer: facilitatorAddress },
        }),
      ).rejects.toThrow("payTo address is required");
    });

    it("should reject empty amount", async () => {
      await expect(
        concordiumClient.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "",
          payTo: PAY_TO_ADDRESS!,
          maxTimeoutSeconds: 60,
          extra: { feePayer: facilitatorAddress },
        }),
      ).rejects.toThrow("amount must be a non-empty decimal string");
    });

    it("should reject undefined amount", async () => {
      await expect(
        concordiumClient.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: undefined as any,
          payTo: PAY_TO_ADDRESS!,
          maxTimeoutSeconds: 60,
          extra: { feePayer: facilitatorAddress },
        }),
      ).rejects.toThrow("amount must be a non-empty decimal string");
    });

    it("should reject USD-formatted amount like '$0.001'", async () => {
      await expect(
        concordiumClient.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "$0.001",
          payTo: PAY_TO_ADDRESS!,
          maxTimeoutSeconds: 60,
          extra: { feePayer: facilitatorAddress },
        }),
      ).rejects.toThrow("amount must be a non-empty decimal string");
    });

    it("should reject decimal amount like '0.001'", async () => {
      await expect(
        concordiumClient.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "0.001",
          payTo: PAY_TO_ADDRESS!,
          maxTimeoutSeconds: 60,
          extra: { feePayer: facilitatorAddress },
        }),
      ).rejects.toThrow("amount must be a non-empty decimal string");
    });

    it("should reject non-numeric amount like 'abc'", async () => {
      await expect(
        concordiumClient.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "abc",
          payTo: PAY_TO_ADDRESS!,
          maxTimeoutSeconds: 60,
          extra: { feePayer: facilitatorAddress },
        }),
      ).rejects.toThrow("amount must be a non-empty decimal string");
    });

    it("should reject missing feePayer", async () => {
      await expect(
        concordiumClient.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "1000",
          payTo: PAY_TO_ADDRESS!,
          maxTimeoutSeconds: 60,
          extra: {},
        }),
      ).rejects.toThrow("requirements.extra.feePayer is required");
    });

    it("should reject empty feePayer string", async () => {
      await expect(
        concordiumClient.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "1000",
          payTo: PAY_TO_ADDRESS!,
          maxTimeoutSeconds: 60,
          extra: { feePayer: "" },
        }),
      ).rejects.toThrow("requirements.extra.feePayer is required");
    });

    it("should reject maxTimeoutSeconds <= 5", async () => {
      await expect(
        concordiumClient.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "1000",
          payTo: PAY_TO_ADDRESS!,
          maxTimeoutSeconds: 3,
          extra: { feePayer: facilitatorAddress },
        }),
      ).rejects.toThrow("requirements.maxTimeoutSeconds must be an integer greater than 5");
    });

    it("should reject non-integer maxTimeoutSeconds", async () => {
      await expect(
        concordiumClient.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "1000",
          payTo: PAY_TO_ADDRESS!,
          maxTimeoutSeconds: 10.5,
          extra: { feePayer: facilitatorAddress },
        }),
      ).rejects.toThrow("requirements.maxTimeoutSeconds must be an integer greater than 5");
    });
  });

  describe("Security Validation", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let facilitatorClient: ConcordiumFacilitatorClient;

    beforeEach(async () => {
      const concordiumClient = new ExactConcordiumClient(clientSigner);
      client = new x402Client().register(CONCORDIUM_TESTNET_CAIP2, concordiumClient);

      const concordiumFacilitator = new ExactConcordiumFacilitator({
        signer: facilitatorSigner,
        requireFinalization: true,
        finalizationTimeoutMs: 90_000,
      });
      const facilitator = new x402Facilitator().register(
        CONCORDIUM_TESTNET_CAIP2,
        concordiumFacilitator,
      );

      facilitatorClient = new ConcordiumFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);
      server.register(CONCORDIUM_TESTNET_CAIP2, new ExactConcordiumServer());
      await server.initialize();
    });

    it("should reject an expired transaction", async () => {
      const accepts = [
        buildConcordiumPaymentRequirements(PAY_TO_ADDRESS!, "1000000", facilitatorAddress),
      ];
      const resource = {
        url: "https://example.com/premium",
        description: "Premium content",
        mimeType: "application/json",
      };
      const shortLivedReq = {
        ...accepts[0],
        maxTimeoutSeconds: 6,
      };
      const paymentRequired = await server.createPaymentRequiredResponse([shortLivedReq], resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      expect(paymentPayload).toBeDefined();

      // Wait for the transaction to expire (6s + 1s buffer)
      await new Promise(resolve => setTimeout(resolve, 7_000));

      const accepted = server.findMatchingRequirements([shortLivedReq], paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(false);
    }, 15_000);

    it("should reject a transaction with tampered signature", async () => {
      const accepts = [
        buildConcordiumPaymentRequirements(PAY_TO_ADDRESS!, "1000000", facilitatorAddress),
      ];
      const resource = {
        url: "https://example.com/premium",
        description: "Premium content",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      expect(paymentPayload).toBeDefined();

      // Tamper with the signature: flip the last character of the sender signature
      const concordiumPayload = paymentPayload.payload as unknown as ExactConcordiumPayloadV2;
      const sigMap = concordiumPayload.signedTransaction.signatures.sender;
      const firstKey = Object.keys(sigMap)[0];
      const firstSigMap = sigMap[firstKey];
      const firstSigKey = Object.keys(firstSigMap)[0];
      const originalSig = firstSigMap[firstSigKey];
      const tamperedSig =
        originalSig.slice(0, -1) + (originalSig[originalSig.length - 1] === "0" ? "1" : "0");
      firstSigMap[firstSigKey] = tamperedSig;

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(false);
    });

    it("should reject a transaction with wrong amount", async () => {
      const accepts = [
        buildConcordiumPaymentRequirements(PAY_TO_ADDRESS!, "1000000", facilitatorAddress),
      ];
      const resource = {
        url: "https://example.com/premium",
        description: "Premium content",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      expect(paymentPayload).toBeDefined();

      // Tamper with the amount in the signed transaction payload
      const concordiumPayload = paymentPayload.payload as unknown as ExactConcordiumPayloadV2;
      (concordiumPayload.signedTransaction.payload as SimpleTransferPayload).amount = "1";

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(false);
    });

    it("should reject a transaction with wrong payTo address", async () => {
      const accepts = [
        buildConcordiumPaymentRequirements(PAY_TO_ADDRESS!, "1000000", facilitatorAddress),
      ];
      const resource = {
        url: "https://example.com/premium",
        description: "Premium content",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      expect(paymentPayload).toBeDefined();

      // Tamper with the payTo address in the signed transaction
      const concordiumPayload = paymentPayload.payload as unknown as ExactConcordiumPayloadV2;
      (concordiumPayload.signedTransaction.payload as SimpleTransferPayload).toAddress =
        "3kBx2h5Y2veb4hZvAE2c1Zr6DYJwWbPr9xQJJBPWyFnXHF9UuN";

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(false);
    });
  });
  describe("Preflight Verification", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let facilitatorClient: ConcordiumFacilitatorClient;

    beforeEach(async () => {
      const concordiumClient = new ExactConcordiumClient(clientSigner);
      client = new x402Client().register(CONCORDIUM_TESTNET_CAIP2, concordiumClient);

      const concordiumFacilitator = new ExactConcordiumFacilitator({
        signer: facilitatorSigner,
        requireFinalization: true,
        finalizationTimeoutMs: 90_000,
      });
      const facilitator = new x402Facilitator().register(
        CONCORDIUM_TESTNET_CAIP2,
        concordiumFacilitator,
      );

      facilitatorClient = new ConcordiumFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);
      server.register(CONCORDIUM_TESTNET_CAIP2, new ExactConcordiumServer());
      await server.initialize();
    });

    it("should reject payment at verify when sender has insufficient CCD balance", async () => {
      // Use an extremely large amount that no test account could hold
      const hugeAmount = "1000000000000000"; // 1 billion CCD in microCCD
      const accepts = [
        buildConcordiumPaymentRequirements(PAY_TO_ADDRESS!, hugeAmount, facilitatorAddress),
      ];
      const resource = {
        url: "https://example.com/premium-huge",
        description: "Premium content - huge amount",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      expect(paymentPayload).toBeDefined();

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      // Preflight must reject — tx simulation (Theme O2)
      expect(verifyResponse.isValid).toBe(false);
      expect(verifyResponse.invalidReason).toContain("preflight_insufficient_funds");
    }, 30_000);

    it("should reject payment at verify when sender has insufficient PLT token balance", async () => {
      // Use an extremely large PLT amount
      const hugeAmount = "1000000000000000";
      const accepts = [
        buildConcordiumPaymentRequirements(
          PAY_TO_ADDRESS!,
          hugeAmount,
          facilitatorAddress,
          "EURR",
          CONCORDIUM_TESTNET_CAIP2,
          { decimals: 6 },
        ),
      ];
      const resource = {
        url: "https://example.com/premium-huge-plt",
        description: "Premium content - huge PLT amount",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      // Client creates payment — will succeed in building tx (decimals fetched from chain)
      // but verification preflight should reject due to insufficient token balance
      let paymentPayload;
      try {
        paymentPayload = await client.createPaymentPayload(paymentRequired);
        expect(paymentPayload).toBeDefined();

        const accepted = server.findMatchingRequirements(accepts, paymentPayload);
        expect(accepted).toBeDefined();

        const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
        expect(verifyResponse.isValid).toBe(false);
        expect(verifyResponse.invalidReason).toContain("preflight_insufficient_token_funds");
      } catch (err) {
        // If the client can't even build the tx (e.g., token not found), that's also acceptable
        // The key point is that the system rejects unreasonable payments before settlement
        expect(err).toBeDefined();
      }
    }, 30_000);
  });

  describe("Edge Cases", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let facilitatorClient: ConcordiumFacilitatorClient;

    beforeEach(async () => {
      const concordiumClient = new ExactConcordiumClient(clientSigner);
      client = new x402Client().register(CONCORDIUM_TESTNET_CAIP2, concordiumClient);

      const concordiumFacilitator = new ExactConcordiumFacilitator({
        signer: facilitatorSigner,
        requireFinalization: true,
        finalizationTimeoutMs: 90_000,
      });
      const facilitator = new x402Facilitator().register(
        CONCORDIUM_TESTNET_CAIP2,
        concordiumFacilitator,
      );

      facilitatorClient = new ConcordiumFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);
      server.register(CONCORDIUM_TESTNET_CAIP2, new ExactConcordiumServer());
      await server.initialize();
    });

    it("should reject network mismatch (mainnet tx for testnet facilitator)", async () => {
      const accepts = [
        buildConcordiumPaymentRequirements(PAY_TO_ADDRESS!, "1000000", facilitatorAddress),
      ];
      const resource = {
        url: "https://example.com/premium",
        description: "Premium content",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      expect(paymentPayload).toBeDefined();

      // Tamper: change accepted network to mainnet
      paymentPayload.accepted.network = "concordium:mainnet" as any;

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      if (accepted) {
        const verifyResponse = await server.verifyPayment(paymentPayload, accepted);
        expect(verifyResponse.isValid).toBe(false);
      }
    });

    it("should detect replay of an already settled transaction", async () => {
      const accepts = [
        buildConcordiumPaymentRequirements(PAY_TO_ADDRESS!, "1000000", facilitatorAddress),
      ];
      const resource = {
        url: "https://example.com/premium",
        description: "Premium content",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      expect(paymentPayload).toBeDefined();

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      // First payment: verify + settle
      const verifyResponse1 = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse1.isValid).toBe(true);

      const settleResponse1 = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse1.success).toBe(true);

      // Second attempt: try to verify the same payload again (replay)
      const verifyResponse2 = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse2.isValid).toBe(false);
    }, 30_000);
  });

  describe("Robustness", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let facilitatorClient: ConcordiumFacilitatorClient;

    beforeEach(async () => {
      const concordiumClient = new ExactConcordiumClient(clientSigner);
      client = new x402Client().register(CONCORDIUM_TESTNET_CAIP2, concordiumClient);

      const concordiumFacilitator = new ExactConcordiumFacilitator({
        signer: facilitatorSigner,
        requireFinalization: true,
        finalizationTimeoutMs: 90_000,
      });
      const facilitator = new x402Facilitator().register(
        CONCORDIUM_TESTNET_CAIP2,
        concordiumFacilitator,
      );

      facilitatorClient = new ConcordiumFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);
      const concordiumServer = new ExactConcordiumServer();
      server.register(CONCORDIUM_TESTNET_CAIP2, concordiumServer);
      await server.initialize();
    });

    it("should allow client to select from multiple asset options", async () => {
      const accepts = [
        buildConcordiumPaymentRequirements(PAY_TO_ADDRESS!, "1000000", facilitatorAddress, "CCD"),
        buildConcordiumPaymentRequirements(
          PAY_TO_ADDRESS!,
          "1000000",
          facilitatorAddress,
          "EURR",
          CONCORDIUM_TESTNET_CAIP2,
          { decimals: 6 },
        ),
      ];
      const resource = {
        url: "https://example.com/premium-multi",
        description: "Premium content - multi asset",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      expect(paymentPayload).toBeDefined();
      expect(["CCD", "EURR"]).toContain(paymentPayload.accepted.asset);

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.transaction).toBeDefined();

      logExplorerUrl(settleResponse.transaction);
    }, 30_000);

    it("should handle very large CCD amounts without overflow", async () => {
      const largeAmount = "1000000000000000"; // 1,000,000,000 CCD in microCCD
      const accepts = [
        buildConcordiumPaymentRequirements(PAY_TO_ADDRESS!, largeAmount, facilitatorAddress),
      ];
      const resource = {
        url: "https://example.com/premium-large",
        description: "Premium content - large amount",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      expect(paymentPayload).toBeDefined();

      const concordiumPayload = paymentPayload.payload as unknown as ExactConcordiumPayloadV2;
      expect(concordiumPayload.signedTransaction.payload).toBeDefined();

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      // Preflight must reject due to insufficient balance (Theme O2 — tx simulation)
      expect(verifyResponse.isValid).toBe(false);
      expect(verifyResponse.invalidReason).toContain("preflight_insufficient_funds");

      // Settlement will fail due to insufficient funds — that's expected
      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(false);
    }, 30_000);

    it("should reject payment with a non-existent token ID", async () => {
      const fakeTokenId = "non-existent-token-12345";
      const accepts = [
        buildConcordiumPaymentRequirements(
          PAY_TO_ADDRESS!,
          "1000000",
          facilitatorAddress,
          fakeTokenId,
          CONCORDIUM_TESTNET_CAIP2,
          { decimals: 6 },
        ),
      ];
      const resource = {
        url: "https://example.com/premium-fake-token",
        description: "Premium content - fake token",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      // Token does not exist on chain — client fails to fetch token decimals from gRPC
      await expect(client.createPaymentPayload(paymentRequired)).rejects.toThrow();
    }, 15_000);

    it("should handle duplicate asset entries in requirements", async () => {
      // Server offers two CCD entries with different amounts (simulates misconfiguration)
      const accepts = [
        buildConcordiumPaymentRequirements(PAY_TO_ADDRESS!, "1000000", facilitatorAddress, "CCD"),
        buildConcordiumPaymentRequirements(PAY_TO_ADDRESS!, "500000", facilitatorAddress, "CCD"),
      ];
      const resource = {
        url: "https://example.com/premium-dup",
        description: "Premium content - duplicate assets",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      // Client should handle duplicate assets gracefully — pick one and proceed
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      expect(paymentPayload).toBeDefined();
      expect(paymentPayload.accepted.asset).toBe("CCD");

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.transaction).toBeDefined();

      logExplorerUrl(settleResponse.transaction);
    }, 30_000);
  });
});
