import { beforeEach, describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer, FacilitatorClient } from "@x402/core/server";
import {
  Network,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  SupportedResponse,
} from "@x402/core/types";
import { toClientEvmSigner, toFacilitatorEvmSigner } from "../../src";
import { AuthCaptureEvmScheme as AuthCaptureEvmClient } from "../../src/auth-capture/client/scheme";
import { AuthCaptureEvmScheme as AuthCaptureEvmServer } from "../../src/auth-capture/server/scheme";
import { AuthCaptureEvmScheme as AuthCaptureEvmFacilitator } from "../../src/auth-capture/facilitator/scheme";
import type { AuthCaptureExtra } from "../../src/auth-capture/types";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY as `0x${string}` | undefined;
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY as `0x${string}` | undefined;

const HAS_KEYS = Boolean(CLIENT_PRIVATE_KEY && FACILITATOR_PRIVATE_KEY);
const describeOnChain = HAS_KEYS ? describe : describe.skip;

if (!HAS_KEYS) {
  console.warn(
    "[auth-capture-evm.test.ts] Skipping on-chain tests: CLIENT_PRIVATE_KEY and FACILITATOR_PRIVATE_KEY env vars are required.",
  );
}

const NETWORK: Network = "eip155:84532";
const ASSET_USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

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
 * Builds payment requirements for the auth-capture scheme on Base Sepolia.
 *
 * @param payTo - Receiver address.
 * @param amount - Amount in smallest token units (USDC has 6 decimals).
 * @param captureAuthorizer - Address allowed to authorize/capture/void on escrow: facilitator's submitter EOA, or a smart contract that ultimately calls escrow as msg.sender.
 * @param overrides - Optional `extra` overrides (e.g., paymentFlow, assetTransferMethod).
 * @returns Configured {@link PaymentRequirements}.
 */
function buildAuthCaptureRequirements(
  payTo: `0x${string}`,
  amount: string,
  captureAuthorizer: `0x${string}`,
  overrides: Partial<AuthCaptureExtra> = {},
): PaymentRequirements {
  const now = Math.floor(Date.now() / 1000);
  // captureDeadline must stay >= now + maxTimeoutSeconds through verify+settle
  // (client preApprovalExpiry is now + maxTimeoutSeconds at payload creation).
  const extra: AuthCaptureExtra = {
    captureAuthorizer,
    captureDeadline: now + 7200,
    refundDeadline: now + 14400,
    feeRecipient: captureAuthorizer,
    minFeeBps: 0,
    maxFeeBps: 100,
    name: "USDC",
    version: "2",
    ...overrides,
  };
  return {
    scheme: "auth-capture",
    network: NETWORK,
    asset: ASSET_USDC_BASE_SEPOLIA,
    amount,
    payTo,
    maxTimeoutSeconds: 3600,
    extra: extra as unknown as Record<string, unknown>,
  };
}

/**
 * Wires up client + server + facilitator for live Base Sepolia testing.
 *
 * @returns Pipeline components and addresses.
 */
function buildPipeline(): {
  client: x402Client;
  server: x402ResourceServer;
  receiverAddress: `0x${string}`;
  clientAddress: `0x${string}`;
  facilitatorAddress: `0x${string}`;
  publicClient: ReturnType<typeof createPublicClient>;
} {
  const clientAccount = privateKeyToAccount(CLIENT_PRIVATE_KEY!);
  const facilitatorAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY!);

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

  const facilitator = new x402Facilitator().register(
    NETWORK,
    new AuthCaptureEvmFacilitator(facilitatorSigner),
  );
  const facilitatorClient = new EvmFacilitatorClient(facilitator);

  const clientSigner = toClientEvmSigner(clientAccount, publicClient);
  const client = new x402Client().register(NETWORK, new AuthCaptureEvmClient(clientSigner));

  const server = new x402ResourceServer(facilitatorClient);
  server.register(
    NETWORK,
    new AuthCaptureEvmServer({
      receiverAuthorizerSigner: {
        address: facilitatorAccount.address,
        signTypedData: params => facilitatorAccount.signTypedData(params as never),
      },
    }),
  );

  return {
    client,
    server,
    receiverAddress: facilitatorAccount.address,
    clientAddress: clientAccount.address,
    facilitatorAddress: facilitatorAccount.address,
    publicClient,
  };
}

describe("AuthCapture EVM Integration Tests", () => {
  describeOnChain("x402Client / x402ResourceServer / x402Facilitator - direct API", () => {
    let client: x402Client;
    let server: x402ResourceServer;
    let receiverAddress: `0x${string}`;
    let clientAddress: `0x${string}`;
    let facilitatorAddress: `0x${string}`;

    beforeEach(async () => {
      const pipeline = buildPipeline();
      client = pipeline.client;
      server = pipeline.server;
      receiverAddress = pipeline.receiverAddress;
      clientAddress = pipeline.clientAddress;
      facilitatorAddress = pipeline.facilitatorAddress;
      await server.initialize();
    });

    it(
      "EIP-3009 + paymentFlow escrow — verifies and authorizes escrow",
      { timeout: 60000 },
      async () => {
        const accepts = [
          buildAuthCaptureRequirements(receiverAddress, "1000", facilitatorAddress, {
            assetTransferMethod: "eip3009",
            paymentFlow: "escrow",
            captureMode: "deferred",
          }),
        ];
        const resource = {
          url: "https://example.com/api",
          description: "auth-capture test resource",
          mimeType: "application/json",
        };

        const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
        const payload = await client.createPaymentPayload(paymentRequired);

        expect(payload.x402Version).toBe(2);
        expect(payload.accepted.scheme).toBe("auth-capture");

        const accepted = server.findMatchingRequirements(accepts, payload);
        expect(accepted).toBeDefined();

        // Escrow flow skips facilitator /verify (settle-before-handler). Authorize is settle.
        const settleResponse = await server.settlePayment(payload, accepted!);
        expect(settleResponse.success, JSON.stringify(settleResponse)).toBe(true);
        expect(settleResponse.network).toBe(NETWORK);
        expect(settleResponse.transaction).toBeDefined();
        expect(settleResponse.payer?.toLowerCase()).toBe(clientAddress.toLowerCase());
      },
    );

    it(
      "EIP-3009 + paymentFlow authorization — verifies and charges (single-shot transfer)",
      { timeout: 60000 },
      async () => {
        const accepts = [
          buildAuthCaptureRequirements(receiverAddress, "1000", facilitatorAddress, {
            assetTransferMethod: "eip3009",
            paymentFlow: "authorization",
            receiverAuthorizer: facilitatorAddress,
          }),
        ];
        const resource = {
          url: "https://example.com/api",
          description: "auth-capture charge test",
          mimeType: "application/json",
        };

        const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
        const payload = await client.createPaymentPayload(paymentRequired);
        const accepted = server.findMatchingRequirements(accepts, payload);

        const verifyResponse = await server.verifyPayment(payload, accepted!);
        expect(verifyResponse.isValid, JSON.stringify(verifyResponse)).toBe(true);

        const settleResponse = await server.settlePayment(payload, accepted!);
        expect(settleResponse.success, JSON.stringify(settleResponse)).toBe(true);
        expect(settleResponse.transaction).toBeDefined();
      },
    );

    it(
      "Permit2 + paymentFlow escrow — verifies and authorizes (requires Permit2 pre-approval)",
      { timeout: 60000 },
      async () => {
        const accepts = [
          buildAuthCaptureRequirements(receiverAddress, "1000", facilitatorAddress, {
            assetTransferMethod: "permit2",
            paymentFlow: "escrow",
            captureMode: "deferred",
          }),
        ];
        const resource = {
          url: "https://example.com/api",
          description: "auth-capture Permit2 test",
          mimeType: "application/json",
        };

        const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
        const payload = await client.createPaymentPayload(paymentRequired);
        const accepted = server.findMatchingRequirements(accepts, payload);

        const settleResponse = await server.settlePayment(payload, accepted!);
        expect(settleResponse.success, JSON.stringify(settleResponse)).toBe(true);
        expect(settleResponse.transaction).toBeDefined();
      },
    );

    it(
      "Permit2 + paymentFlow authorization — verifies and charges (requires Permit2 pre-approval)",
      { timeout: 60000 },
      async () => {
        const accepts = [
          buildAuthCaptureRequirements(receiverAddress, "1000", facilitatorAddress, {
            assetTransferMethod: "permit2",
            paymentFlow: "authorization",
            receiverAuthorizer: facilitatorAddress,
          }),
        ];
        const resource = {
          url: "https://example.com/api",
          description: "auth-capture Permit2 charge test",
          mimeType: "application/json",
        };

        const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
        const payload = await client.createPaymentPayload(paymentRequired);
        const accepted = server.findMatchingRequirements(accepts, payload);

        const verifyResponse = await server.verifyPayment(payload, accepted!);
        expect(verifyResponse.isValid, JSON.stringify(verifyResponse)).toBe(true);

        const settleResponse = await server.settlePayment(payload, accepted!);
        expect(settleResponse.success, JSON.stringify(settleResponse)).toBe(true);
        expect(settleResponse.transaction).toBeDefined();
      },
    );
  });
});
