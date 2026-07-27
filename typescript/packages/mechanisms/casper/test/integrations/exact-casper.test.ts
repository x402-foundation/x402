import casperSdk, { type Transaction } from "casper-js-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { NETWORK_CASPER_TESTNET } from "../../src/constants";
import { ExactCasperScheme as ExactCasperClient } from "../../src/exact/client/scheme";
import { ExactCasperScheme as ExactCasperFacilitator } from "../../src/exact/facilitator/scheme";
import { ExactCasperScheme as ExactCasperServer } from "../../src/exact/server/scheme";
import { toClientCasperSigner } from "../../src/signer";
import type {
  CasperAuthorizationState,
  ExactCasperPayload,
  FacilitatorCasperSigner,
} from "../../src/types";

const { KeyAlgorithm, PrivateKey } = casperSdk;

const NETWORK = NETWORK_CASPER_TESTNET as Network;
const ASSET = "aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788";
const PAY_TO = "00aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788";
const TOKEN_NAME = "TestToken";
const TOKEN_VERSION = "1";
const CLIENT_PRIVATE_KEY = PrivateKey.generate(KeyAlgorithm.ED25519);
const FACILITATOR_PRIVATE_KEY = PrivateKey.generate(KeyAlgorithm.ED25519);
const CLIENT_SIGNER = toClientCasperSigner(CLIENT_PRIVATE_KEY);
const CLIENT_ADDRESS = CLIENT_SIGNER.accountAddress();
const FACILITATOR_ADDRESS = FACILITATOR_PRIVATE_KEY.publicKey.accountHash().toHex();

class CasperFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = NETWORK;
  readonly x402Version = 2;

  /**
   * Create a facilitator client wrapper.
   *
   * @param facilitator - x402 facilitator.
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * Verify payment.
   *
   * @param paymentPayload - Payment payload.
   * @param paymentRequirements - Payment requirements.
   * @returns Verify response.
   */
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  /**
   * Settle payment.
   *
   * @param paymentPayload - Payment payload.
   * @param paymentRequirements - Payment requirements.
   * @returns Settle response.
   */
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  /**
   * Get supported kinds.
   *
   * @returns Supported response.
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported());
  }
}

function createMockFacilitatorSigner(
  overrides: Partial<FacilitatorCasperSigner> = {},
): FacilitatorCasperSigner {
  return {
    getNetworkConfig: async () => ({
      chainName: "casper-test",
      rpcUrl: "http://localhost:11101/rpc",
    }),
    getAddresses: () => [FACILITATOR_ADDRESS],
    getPublicKeyHex: () => FACILITATOR_PRIVATE_KEY.publicKey.toHex(),
    getBalance: vi.fn(async () => 10n ** 30n),
    getAuthorizationState: vi.fn(async (): Promise<CasperAuthorizationState> => "unused"),
    assertTransferWithAuthorizationSupported: vi.fn(async () => {}),
    signTransaction: vi.fn(async (_transaction: Transaction) => {}),
    putTransaction: vi.fn(async () => "a".repeat(64)),
    waitForTransaction: vi.fn(async () => {}),
    ...overrides,
  };
}

function buildPaymentRequirements(
  overrides: Partial<PaymentRequirements> = {},
): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET,
    amount: "3000000000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: {
      name: TOKEN_NAME,
      version: TOKEN_VERSION,
    },
    ...overrides,
  };
}

const resource = {
  url: "https://example.com/casper",
  description: "Casper integration resource",
  mimeType: "application/json",
};

function buildClient(): x402Client {
  return new x402Client().register(NETWORK, new ExactCasperClient(CLIENT_SIGNER));
}

async function buildServer(
  facilitatorSigner: FacilitatorCasperSigner = createMockFacilitatorSigner(),
  casperServer: ExactCasperServer = new ExactCasperServer(),
): Promise<x402ResourceServer> {
  const facilitator = new x402Facilitator().register(
    NETWORK,
    new ExactCasperFacilitator(facilitatorSigner),
  );
  const server = new x402ResourceServer(new CasperFacilitatorClient(facilitator));
  server.register(NETWORK, casperServer);
  await server.initialize();
  return server;
}

describe("Casper integration", () => {
  describe("x402Client / x402ResourceServer / x402Facilitator - Casper flow", () => {
    let client: x402Client;
    let server: x402ResourceServer;

    beforeEach(async () => {
      client = buildClient();
      server = await buildServer();
    });

    it("advertises Casper facilitator metadata through getSupported", () => {
      const facilitator = new x402Facilitator().register(
        NETWORK,
        new ExactCasperFacilitator(createMockFacilitatorSigner()),
      );

      expect(facilitator.getSupported().kinds).toEqual([
        expect.objectContaining({
          x402Version: 2,
          scheme: "exact",
          network: NETWORK,
          extra: {},
        }),
      ]);
    });

    it("verifies and settles an exact Casper payment", async () => {
      const accepts = [buildPaymentRequirements()];
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      expect(paymentPayload.x402Version).toBe(2);
      expect(paymentPayload.accepted.scheme).toBe("exact");
      expect(paymentPayload.accepted.network).toBe(NETWORK);
      expect(paymentPayload.accepted.extra?.name).toBe(TOKEN_NAME);
      expect(paymentPayload.accepted.extra?.version).toBe(TOKEN_VERSION);

      const exactPayload = paymentPayload.payload as ExactCasperPayload;
      expect(exactPayload.signature).toMatch(/^01[0-9a-fA-F]{128}$/);
      expect(exactPayload.publicKey).toMatch(/^01[0-9a-fA-F]{64}$/);
      expect(exactPayload.authorization).toMatchObject({
        from: CLIENT_ADDRESS,
        to: PAY_TO,
        value: "3000000000",
        nonce: expect.stringMatching(/^[0-9a-fA-F]{64}$/),
      });

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);
      expect(verifyResponse.payer).toBe(CLIENT_ADDRESS);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.network).toBe(NETWORK);
      expect(settleResponse.transaction).toBe("a".repeat(64));
      expect(settleResponse.payer).toBe(CLIENT_ADDRESS);
    });

    it("rejects a payment when the accepted amount is changed after signing", async () => {
      const accepts = [buildPaymentRequirements()];
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const tamperedRequirements = buildPaymentRequirements({ amount: "3000000001" });

      const verifyResponse = await server.verifyPayment(paymentPayload, tamperedRequirements);

      expect(verifyResponse.isValid).toBe(false);
      expect(verifyResponse.invalidReason).toBe("invalid_exact_casper_facilitator_amount_mismatch");
      expect(verifyResponse.payer).toBe(CLIENT_ADDRESS);
    });

    it("rejects a payment when preflight reports an insufficient balance", async () => {
      server = await buildServer(
        createMockFacilitatorSigner({ getBalance: vi.fn(async () => 1n) }),
      );
      const accepts = [buildPaymentRequirements()];
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);

      expect(verifyResponse.isValid).toBe(false);
      expect(verifyResponse.invalidReason).toBe(
        "invalid_exact_casper_facilitator_insufficient_balance",
      );
      expect(verifyResponse.payer).toBe(CLIENT_ADDRESS);
    });

    it("maps settlement verification failures to unsuccessful settlement responses", async () => {
      server = await buildServer(
        createMockFacilitatorSigner({
          getAuthorizationState: vi.fn(async (): Promise<CasperAuthorizationState> => "used"),
        }),
      );
      const accepts = [buildPaymentRequirements()];
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);

      expect(settleResponse.success).toBe(false);
      expect(settleResponse.errorReason).toBe(
        "invalid_exact_casper_facilitator_authorization_used",
      );
      expect(settleResponse.payer).toBe(CLIENT_ADDRESS);
      expect(settleResponse.transaction).toBe("");
    });
  });

  describe("x402HTTPClient / x402HTTPResourceServer / x402Facilitator - Casper flow", () => {
    let client: x402HTTPClient;
    let httpServer: x402HTTPResourceServer;

    const routes = {
      "/api/protected": {
        accepts: {
          scheme: "exact",
          payTo: PAY_TO,
          price: {
            amount: "3000000000",
            asset: ASSET,
            extra: {
              name: TOKEN_NAME,
              version: TOKEN_VERSION,
            },
          },
          network: NETWORK,
          maxTimeoutSeconds: 300,
        },
        description: "Casper protected API",
        mimeType: "application/json",
      },
    };

    const mockAdapter: HTTPAdapter = {
      getAcceptHeader: () => "application/json",
      getHeader: () => undefined,
      getMethod: () => "GET",
      getPath: () => "/api/protected",
      getUrl: () => "https://example.com/api/protected",
      getUserAgent: () => "IntegrationTest/1.0",
    };

    beforeEach(async () => {
      client = new x402HTTPClient(buildClient());
      httpServer = new x402HTTPResourceServer(await buildServer(), routes);
      mockAdapter.getHeader = () => undefined;
    });

    it("returns 402, verifies PAYMENT-SIGNATURE, and emits PAYMENT-RESPONSE", async () => {
      const context = {
        adapter: mockAdapter,
        method: "GET",
        path: "/api/protected",
      };

      const firstResult = await httpServer.processHTTPRequest(context);
      expect(firstResult.type).toBe("payment-error");

      const firstResponse = (
        firstResult as { type: "payment-error"; response: HTTPResponseInstructions }
      ).response;
      expect(firstResponse.status).toBe(402);
      expect(firstResponse.headers["PAYMENT-REQUIRED"]).toBeDefined();

      const paymentRequired = client.getPaymentRequiredResponse(
        headerName => firstResponse.headers[headerName],
        firstResponse.body,
      );
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const encoded = await client.encodePaymentSignatureHeader(paymentPayload);

      mockAdapter.getHeader = (name: string) => {
        if (name === "PAYMENT-SIGNATURE") {
          return encoded["PAYMENT-SIGNATURE"];
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
      expect(verified.paymentPayload.accepted.network).toBe(NETWORK);
      expect(verified.paymentRequirements.asset).toBe(ASSET);
      expect(verified.paymentRequirements.extra).toMatchObject({
        name: TOKEN_NAME,
        version: TOKEN_VERSION,
      });

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
    let casperServer: ExactCasperServer;

    beforeEach(async () => {
      casperServer = new ExactCasperServer();
      server = await buildServer(createMockFacilitatorSigner(), casperServer);
    });

    it("handles AssetAmount pass-through and preserves Casper token metadata", async () => {
      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: PAY_TO,
        price: {
          amount: "5000000",
          asset: ASSET,
          extra: {
            name: TOKEN_NAME,
            version: TOKEN_VERSION,
            external: "abc123",
          },
        },
        network: NETWORK,
      });

      expect(requirements).toHaveLength(1);
      expect(requirements[0].amount).toBe("5000000");
      expect(requirements[0].asset).toBe(ASSET);
      expect(requirements[0].extra).toMatchObject({
        name: TOKEN_NAME,
        version: TOKEN_VERSION,
        external: "abc123",
      });
    });

    it("converts decimal AssetAmount values using registered Casper asset decimals", async () => {
      casperServer.registerAsset(NETWORK, ASSET, 6);

      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: PAY_TO,
        price: {
          amount: "1.5",
          asset: ASSET,
          extra: {
            name: TOKEN_NAME,
            version: TOKEN_VERSION,
          },
        },
        network: NETWORK,
      });

      expect(requirements[0].amount).toBe("1500000");
      expect(requirements[0].extra).toMatchObject({
        name: TOKEN_NAME,
        version: TOKEN_VERSION,
      });
    });

    it("uses registerMoneyParser for Casper money prices", async () => {
      casperServer.registerMoneyParser(async amount => {
        if (amount > 100) {
          return {
            amount: String(Math.round(amount * 1e9)),
            asset: ASSET,
            extra: {
              name: TOKEN_NAME,
              version: TOKEN_VERSION,
              tier: "large",
            },
          };
        }
        return null;
      });

      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: PAY_TO,
        price: 150,
        network: NETWORK,
      });

      expect(requirements[0].amount).toBe("150000000000");
      expect(requirements[0].asset).toBe(ASSET);
      expect(requirements[0].extra).toMatchObject({
        name: TOKEN_NAME,
        version: TOKEN_VERSION,
        tier: "large",
      });
    });

    it("supports chained and async money parsers", async () => {
      casperServer
        .registerMoneyParser(async amount => {
          if (amount > 1000) {
            return {
              amount: String(Math.round(amount * 1e9)),
              asset: ASSET,
              extra: { name: TOKEN_NAME, version: TOKEN_VERSION, tier: "vip" },
            };
          }
          return null;
        })
        .registerMoneyParser(async amount => {
          await Promise.resolve();
          if (amount > 100) {
            return {
              amount: String(Math.round(amount * 1e9)),
              asset: ASSET,
              extra: { name: TOKEN_NAME, version: TOKEN_VERSION, tier: "premium" },
            };
          }
          return null;
        });

      const vip = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: PAY_TO,
        price: 2000,
        network: NETWORK,
      });
      expect(vip[0].extra?.tier).toBe("vip");

      const premium = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: PAY_TO,
        price: "$150.00",
        network: NETWORK,
      });
      expect(premium[0].amount).toBe("150000000000");
      expect(premium[0].extra?.tier).toBe("premium");
    });

    it("throws for money prices when no Casper money parser supplies a default asset", async () => {
      await expect(
        server.buildPaymentRequirements({
          scheme: "exact",
          payTo: PAY_TO,
          price: "$1.00",
          network: NETWORK,
        }),
      ).rejects.toThrow("invalid_exact_casper_server_no_default_asset");
    });

    it("throws when AssetAmount omits required Casper token metadata", async () => {
      await expect(
        server.buildPaymentRequirements({
          scheme: "exact",
          payTo: PAY_TO,
          price: {
            amount: "1",
            asset: ASSET,
            extra: { version: TOKEN_VERSION },
          },
          network: NETWORK,
        }),
      ).rejects.toThrow("invalid_exact_casper_server_missing_token_name");

      await expect(
        server.buildPaymentRequirements({
          scheme: "exact",
          payTo: PAY_TO,
          price: {
            amount: "1",
            asset: ASSET,
            extra: { name: TOKEN_NAME },
          },
          network: NETWORK,
        }),
      ).rejects.toThrow("invalid_exact_casper_server_missing_token_version");
    });
  });
});
