import { randomBytes } from "node:crypto";
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
import { toClientEvmSigner, toFacilitatorEvmSigner } from "../../src";
import { BatchSettlementEvmScheme as BatchSettlementEvmClient } from "../../src/batch-settlement/client/scheme";
import { processSettleResponse } from "../../src/batch-settlement/client/channel";
import { InMemoryClientChannelStorage } from "../../src/batch-settlement/client/storage";
import { BatchSettlementEvmScheme as BatchSettlementEvmServer } from "../../src/batch-settlement/server/scheme";
import { BatchSettlementEvmScheme as BatchSettlementEvmFacilitator } from "../../src/batch-settlement/facilitator/scheme";
import type { AuthorizerSigner } from "../../src/batch-settlement/types";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, createPublicClient, http, getAddress } from "viem";
import { baseSepolia } from "viem/chains";
import { batchSettlementABI } from "../../src/batch-settlement/abi";
import { BATCH_SETTLEMENT_ADDRESS } from "../../src/batch-settlement/constants";

const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY as `0x${string}` | undefined;
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY as `0x${string}` | undefined;
const RECEIVER_AUTHORIZER_PRIVATE_KEY = process.env.RECEIVER_AUTHORIZER_PRIVATE_KEY as
  | `0x${string}`
  | undefined;

const HAS_KEYS = Boolean(CLIENT_PRIVATE_KEY && FACILITATOR_PRIVATE_KEY);
const describeOnChain = HAS_KEYS ? describe : describe.skip;

if (!HAS_KEYS) {
  console.warn(
    "[batch-settlement-evm.test.ts] Skipping on-chain tests: CLIENT_PRIVATE_KEY and FACILITATOR_PRIVATE_KEY env vars are required.",
  );
}

const NETWORK: Network = "eip155:84532";
const ASSET_USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * Waits until an RPC read sees non-zero channel balance (some providers lag after receipt).
 *
 * @param publicClient - Viem public client for the chain.
 * @param channelId - Channel id to poll.
 */
async function waitForChannelBalanceOnChain(
  publicClient: ReturnType<typeof createPublicClient>,
  channelId: `0x${string}`,
): Promise<void> {
  const timeoutMs = 20000;
  const intervalMs = 250;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [balance] = (await publicClient.readContract({
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "channels",
      args: [channelId],
    })) as [bigint, bigint];
    if (balance > 0n) return;
    await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for channel ${channelId} balance > 0`);
}

/**
 * Wraps an x402Facilitator instance for use as a FacilitatorClient.
 */
class EvmFacilitatorClient implements FacilitatorClient {
  /**
   * @param facilitator - The x402 facilitator to wrap.
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * @param paymentPayload - Payment payload to verify.
   * @param paymentRequirements - Payment requirements to verify against.
   * @returns Verification response from the wrapped facilitator.
   */
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  /**
   * @param paymentPayload - Payment payload to settle.
   * @param paymentRequirements - Payment requirements for settlement.
   * @returns Settlement response from the wrapped facilitator.
   */
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  /**
   * @returns Supported payment kinds reported by the wrapped facilitator.
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported());
  }
}

/**
 * Builds payment requirements suitable for the batched scheme on Base Sepolia.
 *
 * @param payTo - Receiver address.
 * @param amount - Amount in smallest token units (USDC has 6 decimals).
 * @param receiverAuthorizer - Receiver-authorizer address (must be non-zero on-chain).
 * @returns Configured {@link PaymentRequirements}.
 */
function buildBatchSettlementRequirements(
  payTo: `0x${string}`,
  amount: string,
  receiverAuthorizer: `0x${string}`,
): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    asset: ASSET_USDC_BASE_SEPOLIA,
    amount,
    payTo,
    maxTimeoutSeconds: 3600,
    extra: {
      name: "USDC",
      version: "2",
      assetTransferMethod: "eip3009",
      receiverAuthorizer,
    },
  };
}

/**
 * Constructs the wired client + server + facilitator pipeline for Base Sepolia
 * batch-settlement integration tests.
 *
 * @returns The configured client/server pair plus the receiver address.
 */
function buildPipeline(): {
  client: x402Client;
  server: x402ResourceServer;
  receiverAddress: `0x${string}`;
  clientAddress: `0x${string}`;
  authorizerSigner: AuthorizerSigner;
  publicClient: ReturnType<typeof createPublicClient>;
  batchSettlementClient: BatchSettlementEvmClient;
  batchSettlementStorage: InMemoryClientChannelStorage;
} {
  const clientAccount = privateKeyToAccount(CLIENT_PRIVATE_KEY!);
  const facilitatorAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY!);
  const authorizerAccount = privateKeyToAccount(
    RECEIVER_AUTHORIZER_PRIVATE_KEY ?? FACILITATOR_PRIVATE_KEY!,
  );

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  const facilitatorWalletClient = createWalletClient({
    account: facilitatorAccount,
    chain: baseSepolia,
    transport: http(),
  });

  const facilitatorSigner = toFacilitatorEvmSigner({
    address: facilitatorAccount.address,
    readContract: args => publicClient.readContract({ ...args, args: args.args || [] } as never),
    verifyTypedData: args => publicClient.verifyTypedData(args as never),
    writeContract: args =>
      facilitatorWalletClient.writeContract({ ...args, args: args.args || [] } as never),
    sendTransaction: args => facilitatorWalletClient.sendTransaction(args),
    waitForTransactionReceipt: args => publicClient.waitForTransactionReceipt(args),
    getCode: args => publicClient.getCode(args),
  });

  const authorizerSigner: AuthorizerSigner = {
    address: authorizerAccount.address,
    signTypedData: msg =>
      authorizerAccount.signTypedData({
        domain: msg.domain,
        types: msg.types,
        primaryType: msg.primaryType,
        message: msg.message,
      } as Parameters<typeof authorizerAccount.signTypedData>[0]),
  };

  const facilitator = new x402Facilitator().register(
    NETWORK,
    new BatchSettlementEvmFacilitator(facilitatorSigner, authorizerSigner),
  );
  const facilitatorClient = new EvmFacilitatorClient(facilitator);

  const clientSigner = toClientEvmSigner(clientAccount, publicClient);
  const channelSalt = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  const batchSettlementStorage = new InMemoryClientChannelStorage();
  const batchSettlementClient = new BatchSettlementEvmClient(clientSigner, {
    depositPolicy: { depositMultiplier: 3 },
    salt: channelSalt,
    storage: batchSettlementStorage,
  });
  const client = new x402Client().register(NETWORK, batchSettlementClient);

  const server = new x402ResourceServer(facilitatorClient);
  server.register(
    NETWORK,
    new BatchSettlementEvmServer(facilitatorAccount.address, {
      receiverAuthorizerSigner: authorizerSigner,
    }),
  );

  return {
    client,
    server,
    receiverAddress: facilitatorAccount.address,
    clientAddress: clientAccount.address,
    authorizerSigner,
    publicClient,
    batchSettlementClient,
    batchSettlementStorage,
  };
}

describe("Batch-Settlement EVM Integration Tests", () => {
  describeOnChain("x402Client / x402ResourceServer / x402Facilitator - direct API", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let receiverAddress: `0x${string}`;
    let clientAddress: `0x${string}`;
    let receiverAuthorizer: `0x${string}`;
    let batchSettlementStorage: InMemoryClientChannelStorage;
    let publicClient: ReturnType<typeof createPublicClient>;

    beforeEach(async () => {
      const pipeline = buildPipeline();
      client = pipeline.client;
      server = pipeline.server;
      receiverAddress = pipeline.receiverAddress;
      clientAddress = pipeline.clientAddress;
      receiverAuthorizer = pipeline.authorizerSigner.address;
      batchSettlementStorage = pipeline.batchSettlementStorage;
      publicClient = pipeline.publicClient;
      await server.initialize();
    });

    it(
      "verifies and settles a deposit-with-voucher payment, then a follow-up voucher payment",
      { timeout: 60000 },
      async () => {
        const accepts = [
          buildBatchSettlementRequirements(receiverAddress, "1000", receiverAuthorizer),
        ];
        const resource = {
          url: "https://example.com/api",
          description: "Batched test resource",
          mimeType: "application/json",
        };

        const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
        const firstPayload = await client.createPaymentPayload(paymentRequired);

        expect(firstPayload.x402Version).toBe(2);
        expect(firstPayload.accepted.scheme).toBe("batch-settlement");
        const firstRaw = firstPayload.payload as Record<string, unknown>;
        expect(firstRaw.type).toBe("deposit");

        const accepted = server.findMatchingRequirements(accepts, firstPayload);
        expect(accepted).toBeDefined();

        const verifyResponse = await server.verifyPayment(firstPayload, accepted!);
        expect(verifyResponse.isValid).toBe(true);
        expect(verifyResponse.payer?.toLowerCase()).toBe(clientAddress.toLowerCase());

        const settleResponse = await server.settlePayment(firstPayload, accepted!);
        expect(settleResponse.success, JSON.stringify(settleResponse)).toBe(true);
        expect(settleResponse.network).toBe(NETWORK);
        expect(settleResponse.transaction).toBeDefined();
        expect(settleResponse.payer?.toLowerCase()).toBe(clientAddress.toLowerCase());

        const depositChannelId = (firstPayload.payload as { voucher: { channelId: `0x${string}` } })
          .voucher.channelId;
        await waitForChannelBalanceOnChain(publicClient, depositChannelId);

        await processSettleResponse(batchSettlementStorage, settleResponse);

        const followupRequired = await server.createPaymentRequiredResponse(accepts, resource);
        const secondPayload = await client.createPaymentPayload(followupRequired);
        const secondRaw = secondPayload.payload as Record<string, unknown>;
        expect(secondRaw.type).toBe("voucher");

        const accepted2 = server.findMatchingRequirements(accepts, secondPayload);
        expect(accepted2).toBeDefined();

        const verify2 = await server.verifyPayment(secondPayload, accepted2!);
        expect(verify2.isValid).toBe(true);

        const settle2 = await server.settlePayment(secondPayload, accepted2!);
        expect(settle2.success, JSON.stringify(settle2)).toBe(true);
        expect(settle2.payer?.toLowerCase()).toBe(clientAddress.toLowerCase());
      },
    );
  });

  describeOnChain("x402HTTPClient / x402HTTPResourceServer / x402Facilitator - HTTP API", () => {
    let httpClient: x402HTTPClient;
    let httpServer: x402HTTPResourceServer;
    let receiverAddress: `0x${string}`;
    let clientAddress: `0x${string}`;

    const routes = {
      "/api/protected": {
        accepts: {
          scheme: "batch-settlement",
          payTo: "0x0000000000000000000000000000000000000000" as `0x${string}`,
          price: "$0.001",
          network: NETWORK,
        },
        description: "Batched protected API",
        mimeType: "application/json",
      },
    };

    const adapter: HTTPAdapter = {
      getHeader: () => undefined,
      getMethod: () => "GET",
      getPath: () => "/api/protected",
      getUrl: () => "https://example.com/api/protected",
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "TestClient/1.0",
    };

    beforeEach(async () => {
      const pipeline = buildPipeline();
      receiverAddress = pipeline.receiverAddress;
      clientAddress = pipeline.clientAddress;

      routes["/api/protected"].accepts.payTo = receiverAddress;

      const resourceServer = new x402ResourceServer(
        new EvmFacilitatorClient(
          new x402Facilitator().register(
            NETWORK,
            new BatchSettlementEvmFacilitator(
              toFacilitatorEvmSigner({
                address: privateKeyToAccount(FACILITATOR_PRIVATE_KEY!).address,
                readContract: args =>
                  pipeline.publicClient.readContract({
                    ...args,
                    args: args.args || [],
                  } as never),
                verifyTypedData: args => pipeline.publicClient.verifyTypedData(args as never),
                writeContract: args =>
                  createWalletClient({
                    account: privateKeyToAccount(FACILITATOR_PRIVATE_KEY!),
                    chain: baseSepolia,
                    transport: http(),
                  }).writeContract({ ...args, args: args.args || [] } as never),
                sendTransaction: args =>
                  createWalletClient({
                    account: privateKeyToAccount(FACILITATOR_PRIVATE_KEY!),
                    chain: baseSepolia,
                    transport: http(),
                  }).sendTransaction(args),
                waitForTransactionReceipt: args =>
                  pipeline.publicClient.waitForTransactionReceipt(args),
                getCode: args => pipeline.publicClient.getCode(args),
              }),
              pipeline.authorizerSigner,
            ),
          ),
        ),
      );
      resourceServer.register(
        NETWORK,
        new BatchSettlementEvmServer(receiverAddress, {
          receiverAuthorizerSigner: pipeline.authorizerSigner,
        }),
      );
      await resourceServer.initialize();

      httpServer = new x402HTTPResourceServer(resourceServer, routes);
      httpClient = new x402HTTPClient(pipeline.client) as x402HTTPClient;
    });

    it(
      "negotiates a batched payment via HTTP middleware end-to-end",
      { timeout: 60000 },
      async () => {
        const context = { adapter, path: "/api/protected", method: "GET" };

        const initial = (await httpServer.processHTTPRequest(context))!;
        expect(initial.type).toBe("payment-error");
        const response402 = (
          initial as { type: "payment-error"; response: HTTPResponseInstructions }
        ).response;
        expect(response402.status).toBe(402);
        expect(response402.headers["PAYMENT-REQUIRED"]).toBeDefined();

        const paymentRequired = httpClient.getPaymentRequiredResponse(
          name => response402.headers[name],
          response402.body,
        );
        const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
        expect(paymentPayload.accepted.scheme).toBe("batch-settlement");

        const requestHeaders = await httpClient.encodePaymentSignatureHeader(paymentPayload);
        adapter.getHeader = (name: string) =>
          name === "PAYMENT-SIGNATURE" ? requestHeaders["PAYMENT-SIGNATURE"] : undefined;

        const verified = await httpServer.processHTTPRequest(context);
        expect(verified.type).toBe("payment-verified");

        const { paymentPayload: verifiedPayload, paymentRequirements: verifiedReqs } = verified as {
          type: "payment-verified";
          paymentPayload: PaymentPayload;
          paymentRequirements: PaymentRequirements;
        };

        const settlement = await httpServer.processSettlement(verifiedPayload, verifiedReqs, 200);
        expect(settlement.success).toBe(true);
        if (settlement.success) {
          expect(settlement.headers["PAYMENT-RESPONSE"]).toBeDefined();
        }
        expect(clientAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      },
    );
  });
});
