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
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { AccountId, Client, PrivateKey, Transaction, TransferTransaction } from "@hiero-ledger/sdk";
import {
  type FacilitatorHederaSigner,
  createClientHederaSigner,
  createHederaSignAndSubmitTransaction,
} from "../../src/signer";
import { createHederaPreflightTransfer } from "../../src/preflight";
import { ExactHederaScheme as ExactHederaClient } from "../../src/exact/client/scheme";
import { ExactHederaScheme as ExactHederaServer } from "../../src/exact/server/scheme";
import { ExactHederaScheme as ExactHederaFacilitator } from "../../src/exact/facilitator/scheme";
import { HEDERA_TESTNET_USDC } from "../../src/constants";

class HederaFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = "hedera:testnet";
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

describe("Hedera integration", () => {
  const deterministicClientAccount = "0.0.9001";
  const deterministicFeePayer = "0.0.5001";
  const deterministicResourceServerAccount = "0.0.7001";

  const liveClientAccount = process.env.HEDERA_CLIENT_ACCOUNT_ID;
  const liveClientPrivateKeyRaw = process.env.HEDERA_CLIENT_PRIVATE_KEY;
  const liveFeePayerAccount = process.env.HEDERA_FACILITATOR_ACCOUNT_ID;
  const liveFeePayerPrivateKeyRaw = process.env.HEDERA_FACILITATOR_PRIVATE_KEY;
  const liveResourceServerAccount = process.env.HEDERA_RESOURCE_SERVER_ACCOUNT_ID;
  const hasLiveEnv = Boolean(
    liveClientAccount &&
      liveClientPrivateKeyRaw &&
      liveFeePayerAccount &&
      liveFeePayerPrivateKeyRaw &&
      liveResourceServerAccount,
  );

  function parseEcdsaPrivateKeyFromEnv(name: string, value: string): PrivateKey {
    try {
      return PrivateKey.fromStringECDSA(value);
    } catch {
      throw new Error(
        `${name} must be a valid ECDSA private key string (0x-prefixed raw key or DER-encoded key).`,
      );
    }
  }

  function createLocalFinalizerSigner(
    feePayerAccountId: string,
    feePayerPrivateKey: PrivateKey,
  ): FacilitatorHederaSigner {
    return {
      getAddresses: () => [feePayerAccountId],
      signAndSubmitTransaction: async (transactionBase64: string) => {
        const tx = Transaction.fromBytes(Buffer.from(transactionBase64, "base64"));
        if (!(tx instanceof TransferTransaction)) {
          throw new Error("expected TransferTransaction");
        }
        const signed = await tx.sign(feePayerPrivateKey);
        return { transactionId: signed.transactionId?.toString() ?? "" };
      },
      resolveAccount: async () => ({ exists: true, isAlias: false }),
    };
  }

  function createLiveNetworkSigner(
    feePayerAccountId: string,
    feePayerPrivateKey: PrivateKey,
  ): FacilitatorHederaSigner {
    const buildClient = (network: string): Client => {
      const client = network === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet();
      client.setOperator(AccountId.fromString(feePayerAccountId), feePayerPrivateKey);
      return client;
    };
    return {
      getAddresses: () => [feePayerAccountId],
      signAndSubmitTransaction: createHederaSignAndSubmitTransaction(
        buildClient,
        feePayerPrivateKey,
      ),
      resolveAccount: async () => ({ exists: true, isAlias: false }),
      preflightTransfer: createHederaPreflightTransfer(buildClient),
    };
  }

  describe("x402Client / x402ResourceServer / x402Facilitator flow", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let paymentRequirements: PaymentRequirements;
    let resource: { url: string; description: string; mimeType: string };

    beforeEach(async () => {
      const clientPrivateKey = PrivateKey.generateED25519();
      const feePayerPrivateKey = PrivateKey.generateED25519();
      const clientSigner = createClientHederaSigner(deterministicClientAccount, clientPrivateKey, {
        network: "hedera:testnet",
      });
      client = new x402Client().register("hedera:testnet", new ExactHederaClient(clientSigner));
      const hederaFacilitator = new ExactHederaFacilitator(
        createLocalFinalizerSigner(deterministicFeePayer, feePayerPrivateKey),
      );

      const facilitator = new x402Facilitator().register("hedera:testnet", hederaFacilitator);
      const facilitatorClient = new HederaFacilitatorClient(facilitator);
      server = new x402ResourceServer(facilitatorClient);
      server.register("hedera:testnet", new ExactHederaServer());
      await server.initialize();

      paymentRequirements = {
        scheme: "exact",
        network: "hedera:testnet" as Network,
        asset: "0.0.0",
        amount: "1",
        payTo: deterministicResourceServerAccount,
        maxTimeoutSeconds: 180,
        extra: { feePayer: deterministicFeePayer },
      };
      resource = {
        url: "https://example.com/paid",
        description: "Protected endpoint",
        mimeType: "application/json",
      };
    });

    it("verifies and settles a client payment end-to-end", async () => {
      const accepts = [paymentRequirements];

      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);
      expect(verifyResponse.payer).toBe(deterministicClientAccount);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.network).toBe("hedera:testnet");
      expect(settleResponse.payer).toBe(deterministicClientAccount);
      expect(settleResponse.transaction).toContain("0.0.5001@");
    });

    it("verifies and settles a USDC client payment end-to-end", async () => {
      const usdcRequirements: PaymentRequirements = {
        ...paymentRequirements,
        asset: HEDERA_TESTNET_USDC,
        amount: "10000", // 0.01 USDC at 6 decimals
      };
      const accepts = [usdcRequirements];

      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();
      expect(accepted!.asset).toBe(HEDERA_TESTNET_USDC);

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);
      expect(verifyResponse.payer).toBe(deterministicClientAccount);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.network).toBe("hedera:testnet");
      expect(settleResponse.payer).toBe(deterministicClientAccount);
    });
  });

  describe("x402HTTPClient / x402HTTPResourceServer flow", () => {
    let client: x402HTTPClient;
    let httpServer: x402HTTPResourceServer;

    const routes = {
      "/api/protected": {
        accepts: {
          scheme: "exact",
          payTo: deterministicResourceServerAccount,
          price: {
            amount: "1",
            asset: "0.0.0",
          },
          network: "hedera:testnet" as Network,
        },
        description: "Protected API",
        mimeType: "application/json",
      },
    };

    const mockAdapter: HTTPAdapter = {
      getHeader: () => undefined,
      getMethod: () => "GET",
      getPath: () => "/api/protected",
      getUrl: () => "https://example.com/api/protected",
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "IntegrationTest/1.0",
    };

    beforeEach(async () => {
      const clientPrivateKey = PrivateKey.generateED25519();
      const feePayerPrivateKey = PrivateKey.generateED25519();
      const clientSigner = createClientHederaSigner(deterministicClientAccount, clientPrivateKey, {
        network: "hedera:testnet",
      });
      const paymentClient = new x402Client().register(
        "hedera:testnet",
        new ExactHederaClient(clientSigner),
      );
      client = new x402HTTPClient(paymentClient) as x402HTTPClient;

      const hederaFacilitator = new ExactHederaFacilitator(
        createLocalFinalizerSigner(deterministicFeePayer, feePayerPrivateKey),
      );
      const facilitator = new x402Facilitator().register("hedera:testnet", hederaFacilitator);
      const resourceServer = new x402ResourceServer(new HederaFacilitatorClient(facilitator));
      resourceServer.register("hedera:testnet", new ExactHederaServer());
      await resourceServer.initialize();

      httpServer = new x402HTTPResourceServer(resourceServer, routes);
    });

    it("returns 402 then verifies payment via PAYMENT-SIGNATURE", async () => {
      const context = {
        adapter: mockAdapter,
        path: "/api/protected",
        method: "GET",
      };
      const firstResult = await httpServer.processHTTPRequest(context);
      expect(firstResult.type).toBe("payment-error");

      const firstResponse = (
        firstResult as { type: "payment-error"; response: HTTPResponseInstructions }
      ).response;
      expect(firstResponse.status).toBe(402);

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

      const {
        paymentPayload: verifiedPaymentPayload,
        paymentRequirements: verifiedPaymentRequirements,
      } = secondResult as {
        type: "payment-verified";
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };
      const settlementResult = await httpServer.processSettlement(
        verifiedPaymentPayload,
        verifiedPaymentRequirements,
        200,
      );
      expect(settlementResult.success).toBe(true);
      if (settlementResult.success) {
        expect(settlementResult.headers["PAYMENT-RESPONSE"]).toBeDefined();
      }
    });
  });

  describe.skipIf(!hasLiveEnv)("Live Hedera network integration (env-gated)", () => {
    it("verifies and settles using real Hedera submission", async () => {
      const network = "hedera:testnet" as Network;
      const parsedLiveClientPrivateKey = parseEcdsaPrivateKeyFromEnv(
        "HEDERA_CLIENT_PRIVATE_KEY",
        liveClientPrivateKeyRaw!,
      );
      const parsedLiveFeePayerPrivateKey = parseEcdsaPrivateKeyFromEnv(
        "HEDERA_FACILITATOR_PRIVATE_KEY",
        liveFeePayerPrivateKeyRaw!,
      );
      const clientSigner = createClientHederaSigner(
        liveClientAccount!,
        parsedLiveClientPrivateKey,
        {
          network,
        },
      );
      const hederaFacilitator = new ExactHederaFacilitator(
        createLiveNetworkSigner(liveFeePayerAccount!, parsedLiveFeePayerPrivateKey),
      );
      const facilitator = new x402Facilitator().register(network, hederaFacilitator);
      const server = new x402ResourceServer(new HederaFacilitatorClient(facilitator));
      server.register(network, new ExactHederaServer());
      await server.initialize();
      const client = new x402Client().register(network, new ExactHederaClient(clientSigner));

      const accepts = [
        {
          scheme: "exact",
          network,
          asset: "0.0.0",
          amount: "1",
          payTo: liveResourceServerAccount!,
          maxTimeoutSeconds: 180,
          extra: { feePayer: liveFeePayerAccount! },
        },
      ];
      const resource = {
        url: "https://example.com/paid",
        description: "Live Hedera check",
        mimeType: "application/json",
      };

      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.transaction.length).toBeGreaterThan(0);
    });

    it("preflight rejects verify when payer has insufficient balance", async () => {
      const network = "hedera:testnet" as Network;
      const parsedLiveClientPrivateKey = parseEcdsaPrivateKeyFromEnv(
        "HEDERA_CLIENT_PRIVATE_KEY",
        liveClientPrivateKeyRaw!,
      );
      const parsedLiveFeePayerPrivateKey = parseEcdsaPrivateKeyFromEnv(
        "HEDERA_FACILITATOR_PRIVATE_KEY",
        liveFeePayerPrivateKeyRaw!,
      );
      const clientSigner = createClientHederaSigner(
        liveClientAccount!,
        parsedLiveClientPrivateKey,
        { network },
      );
      const hederaFacilitator = new ExactHederaFacilitator(
        createLiveNetworkSigner(liveFeePayerAccount!, parsedLiveFeePayerPrivateKey),
      );
      const facilitator = new x402Facilitator().register(network, hederaFacilitator);
      const server = new x402ResourceServer(new HederaFacilitatorClient(facilitator));
      server.register(network, new ExactHederaServer());
      await server.initialize();
      const client = new x402Client().register(network, new ExactHederaClient(clientSigner));

      const unreasonableAmount = "100000000000000000"; // ~10^18 tinybars, far above any testnet balance
      const accepts = [
        {
          scheme: "exact",
          network,
          asset: "0.0.0",
          amount: unreasonableAmount,
          payTo: liveResourceServerAccount!,
          maxTimeoutSeconds: 180,
          extra: { feePayer: liveFeePayerAccount! },
        },
      ];
      const resource = {
        url: "https://example.com/paid",
        description: "Preflight insufficient-balance check",
        mimeType: "application/json",
      };

      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(false);
      expect(verifyResponse.invalidReason).toBe("invalid_exact_hedera_payload_preflight_failed");
      expect(verifyResponse.invalidMessage).toContain("insufficient_balance");
    });

    it("verifies and settles a real USDC submission", async () => {
      const network = "hedera:testnet" as Network;
      const usdcAsset = process.env.HEDERA_LIVE_USDC_ASSET ?? HEDERA_TESTNET_USDC;
      const parsedLiveClientPrivateKey = parseEcdsaPrivateKeyFromEnv(
        "HEDERA_CLIENT_PRIVATE_KEY",
        liveClientPrivateKeyRaw!,
      );
      const parsedLiveFeePayerPrivateKey = parseEcdsaPrivateKeyFromEnv(
        "HEDERA_FACILITATOR_PRIVATE_KEY",
        liveFeePayerPrivateKeyRaw!,
      );
      const clientSigner = createClientHederaSigner(
        liveClientAccount!,
        parsedLiveClientPrivateKey,
        { network },
      );
      const hederaFacilitator = new ExactHederaFacilitator(
        createLiveNetworkSigner(liveFeePayerAccount!, parsedLiveFeePayerPrivateKey),
      );
      const facilitator = new x402Facilitator().register(network, hederaFacilitator);
      const server = new x402ResourceServer(new HederaFacilitatorClient(facilitator));
      server.register(network, new ExactHederaServer());
      await server.initialize();
      const client = new x402Client().register(network, new ExactHederaClient(clientSigner));

      const accepts = [
        {
          scheme: "exact",
          network,
          asset: usdcAsset,
          amount: "10000", // 0.01 USDC
          payTo: liveResourceServerAccount!,
          maxTimeoutSeconds: 180,
          extra: { feePayer: liveFeePayerAccount! },
        },
      ];
      const resource = {
        url: "https://example.com/paid",
        description: "Live Hedera USDC settle",
        mimeType: "application/json",
      };

      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      console.log(JSON.stringify(verifyResponse));
      expect(verifyResponse.isValid).toBe(true);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.transaction.length).toBeGreaterThan(0);
    });

    it.skipIf(!process.env.HEDERA_UNASSOCIATED_RESOURCE_SERVER_ACCOUNT_ID)(
      "reports failure when USDC transfer fails on-chain because payTo is not token-associated",
      async () => {
        const network = "hedera:testnet" as Network;
        const usdcAsset = process.env.HEDERA_LIVE_USDC_ASSET ?? HEDERA_TESTNET_USDC;
        const unassociatedPayTo = process.env.HEDERA_UNASSOCIATED_RESOURCE_SERVER_ACCOUNT_ID!;
        const parsedLiveClientPrivateKey = parseEcdsaPrivateKeyFromEnv(
          "HEDERA_CLIENT_PRIVATE_KEY",
          liveClientPrivateKeyRaw!,
        );
        const parsedLiveFeePayerPrivateKey = parseEcdsaPrivateKeyFromEnv(
          "HEDERA_FACILITATOR_PRIVATE_KEY",
          liveFeePayerPrivateKeyRaw!,
        );
        const clientSigner = createClientHederaSigner(
          liveClientAccount!,
          parsedLiveClientPrivateKey,
          { network },
        );
        // Disable preflight so settlement reaches execute()+getReceipt() and
        // surfaces the real on-chain failure instead of being caught upstream.
        const liveSigner: FacilitatorHederaSigner = {
          ...createLiveNetworkSigner(liveFeePayerAccount!, parsedLiveFeePayerPrivateKey),
          preflightTransfer: undefined,
        };
        const hederaFacilitator = new ExactHederaFacilitator(liveSigner);
        const facilitator = new x402Facilitator().register(network, hederaFacilitator);
        const server = new x402ResourceServer(new HederaFacilitatorClient(facilitator));
        server.register(network, new ExactHederaServer());
        await server.initialize();
        const client = new x402Client().register(network, new ExactHederaClient(clientSigner));

        const accepts = [
          {
            scheme: "exact",
            network,
            asset: usdcAsset,
            amount: "10000",
            payTo: unassociatedPayTo,
            maxTimeoutSeconds: 180,
            extra: { feePayer: liveFeePayerAccount! },
          },
        ];
        const resource = {
          url: "https://example.com/paid",
          description: "Live Hedera USDC unassociated payTo",
          mimeType: "application/json",
        };

        const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
        const paymentPayload = await client.createPaymentPayload(paymentRequired);
        const accepted = server.findMatchingRequirements(accepts, paymentPayload);

        const settleResponse = await server.settlePayment(paymentPayload, accepted!);
        // On a real unassociated recipient the Hedera consensus status returns
        // TOKEN_NOT_ASSOCIATED_TO_ACCOUNT. The facilitator must surface that
        // as a settlement failure instead of returning success with a tx id.
        expect(settleResponse.success).toBe(false);
        expect(settleResponse.errorReason).toBe("transaction_failed");
        expect(settleResponse.errorMessage).toMatch(/TOKEN_NOT_ASSOCIATED_TO_ACCOUNT/i);
      },
    );
  });
});
