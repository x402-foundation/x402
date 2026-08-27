/**
 * Auth-capture custom-operator integration tests against live Base Sepolia.
 *
 * Deploys (CREATE2, skip-if-present) a spec-minimum forwarding operator and two
 * adversarial operators, then checks facilitator verify/settle against real
 * AuthCaptureEscrow + eth_simulateV1.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { AUTH_CAPTURE_ESCROW_ADDRESS } from "../../src/auth-capture/constants";
import { ESCROW_EVENTS_ABI } from "../../src/auth-capture/abi";
import { ErrSimulationFailed } from "../../src/auth-capture/errors";
import type { AuthCaptureExtra } from "../../src/auth-capture/types";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddressEqual,
  nonceManager,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  ensureCreate2Operator,
  loadOperatorArtifact,
  operatorCreate2Salt,
} from "./helpers/authCaptureOperators";

const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY as `0x${string}` | undefined;
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY as `0x${string}` | undefined;

const HAS_KEYS = Boolean(CLIENT_PRIVATE_KEY && FACILITATOR_PRIVATE_KEY);
const describeOnChain = HAS_KEYS ? describe : describe.skip;

if (!HAS_KEYS) {
  console.warn(
    "[auth-capture-custom-operator.test.ts] Skipping on-chain tests: CLIENT_PRIVATE_KEY and FACILITATOR_PRIVATE_KEY env vars are required.",
  );
}

const NETWORK: Network = "eip155:84532";
const ASSET_USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RPC_URL = process.env.EVM_RPC_URL?.trim();
const transport = RPC_URL ? http(RPC_URL) : http();

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
 * Builds payment requirements for a custom-operator escrow collect on Base Sepolia.
 *
 * @param payTo - Receiver address.
 * @param amount - Amount in smallest token units (USDC has 6 decimals).
 * @param captureAuthorizer - Allowlisted custom operator contract.
 * @returns Configured {@link PaymentRequirements}.
 */
function buildCustomEscrowRequirements(
  payTo: `0x${string}`,
  amount: string,
  captureAuthorizer: `0x${string}`,
): PaymentRequirements {
  const now = Math.floor(Date.now() / 1000);
  // captureDeadline must stay >= now + maxTimeoutSeconds through verify+settle.
  const extra: AuthCaptureExtra = {
    captureAuthorizer,
    operatorType: "custom",
    captureDeadline: now + 7200,
    refundDeadline: now + 14400,
    feeRecipient: zeroAddress,
    minFeeBps: 0,
    maxFeeBps: 0,
    name: "USDC",
    version: "2",
    assetTransferMethod: "eip3009",
    paymentFlow: "escrow",
    captureMode: "deferred",
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

type Pipeline = {
  client: x402Client;
  server: x402ResourceServer;
  facilitatorClient: EvmFacilitatorClient;
  receiverAddress: `0x${string}`;
  clientAddress: `0x${string}`;
  writeContractCalls: { count: number };
  publicClient: ReturnType<typeof createPublicClient>;
};

/**
 * Wires up client + server + facilitator for custom-operator testing.
 *
 * @param operators - Allowlisted custom operator addresses.
 * @returns Pipeline components and a write-counter for asserting no broadcast.
 */
function buildPipeline(operators: readonly `0x${string}`[]): Pipeline {
  const clientAccount = privateKeyToAccount(CLIENT_PRIVATE_KEY!);
  const facilitatorAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY!, { nonceManager });

  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const facilitatorWalletClient = createWalletClient({
    account: facilitatorAccount,
    chain: baseSepolia,
    transport,
  });

  const writeContractCalls = { count: 0 };

  const facilitatorSigner = toFacilitatorEvmSigner({
    address: facilitatorAccount.address,
    readContract: args => publicClient.readContract({ ...args, args: args.args || [] } as never),
    verifyTypedData: args => publicClient.verifyTypedData(args as never),
    writeContract: args => {
      writeContractCalls.count += 1;
      return facilitatorWalletClient.writeContract({
        ...args,
        args: args.args || [],
      } as never);
    },
    sendTransaction: args => facilitatorWalletClient.sendTransaction(args),
    waitForTransactionReceipt: args => publicClient.waitForTransactionReceipt(args),
    getCode: args => publicClient.getCode(args),
    simulateCalls: args =>
      publicClient.simulateCalls(args as Parameters<typeof publicClient.simulateCalls>[0]),
  });

  const facilitator = new x402Facilitator().register(
    NETWORK,
    new AuthCaptureEvmFacilitator(facilitatorSigner, {
      operators: operators.map(address => ({ address, operatorType: "custom" as const })),
      customOperatorAuthorizeGasLimit: 1_000_000n,
    }),
  );
  const facilitatorClient = new EvmFacilitatorClient(facilitator);

  const clientSigner = toClientEvmSigner(clientAccount, publicClient);
  const client = new x402Client().register(NETWORK, new AuthCaptureEvmClient(clientSigner));

  const server = new x402ResourceServer(facilitatorClient);
  server.register(NETWORK, new AuthCaptureEvmServer());

  return {
    client,
    server,
    facilitatorClient,
    receiverAddress: facilitatorAccount.address,
    clientAddress: clientAccount.address,
    writeContractCalls,
    publicClient,
  };
}

/**
 * Signs a custom-operator collect payload against the given operator.
 *
 * @param pipeline - Wired client/server.
 * @param operator - Custom operator used as extra.captureAuthorizer.
 * @returns Matching requirements and the client payload.
 */
async function createCustomCollect(
  pipeline: Pipeline,
  operator: `0x${string}`,
): Promise<{ accepted: PaymentRequirements; payload: PaymentPayload }> {
  const accepts = [buildCustomEscrowRequirements(pipeline.receiverAddress, "1000", operator)];
  const resource = {
    url: "https://example.com/api",
    description: "auth-capture custom-operator test",
    mimeType: "application/json",
  };
  const paymentRequired = await pipeline.server.createPaymentRequiredResponse(accepts, resource);
  const payload = await pipeline.client.createPaymentPayload(paymentRequired);
  const accepted = pipeline.server.findMatchingRequirements(accepts, payload);
  expect(accepted).toBeDefined();
  return { accepted: accepted!, payload };
}

describe("AuthCapture EVM custom operator", () => {
  describeOnChain("forwarding vs adversarial operators", () => {
    let forwarding: `0x${string}`;
    let noop: `0x${string}`;
    let gasWaster: `0x${string}`;
    let pipeline: Pipeline;

    beforeAll(async () => {
      const facilitatorAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY!, { nonceManager });
      const publicClient = createPublicClient({ chain: baseSepolia, transport });
      const walletClient = createWalletClient({
        account: facilitatorAccount,
        chain: baseSepolia,
        transport,
      });
      const deployer = {
        sendTransaction: (args: { to: `0x${string}`; data: `0x${string}`; gas?: bigint }) =>
          walletClient.sendTransaction({
            account: facilitatorAccount,
            chain: baseSepolia,
            ...args,
          }),
      };

      forwarding = await ensureCreate2Operator(
        publicClient,
        deployer,
        loadOperatorArtifact("ForwardingOperator"),
        operatorCreate2Salt("ForwardingOperator"),
        [AUTH_CAPTURE_ESCROW_ADDRESS],
      );
      noop = await ensureCreate2Operator(
        publicClient,
        deployer,
        loadOperatorArtifact("NoopOperator"),
        operatorCreate2Salt("NoopOperator"),
      );
      gasWaster = await ensureCreate2Operator(
        publicClient,
        deployer,
        loadOperatorArtifact("GasWastingOperator"),
        operatorCreate2Salt("GasWastingOperator"),
      );
    }, 120_000);

    beforeEach(async () => {
      pipeline = buildPipeline([forwarding, noop, gasWaster]);
      await pipeline.server.initialize();
    });

    it(
      "forwarding operator — verify and settle authorize through canonical escrow",
      { timeout: 60_000 },
      async () => {
        const { accepted, payload } = await createCustomCollect(pipeline, forwarding);

        // Escrow skips resource-server /verify; call the facilitator so simulateCalls runs.
        const verifyResponse = await pipeline.facilitatorClient.verify(payload, accepted);
        expect(verifyResponse.isValid, JSON.stringify(verifyResponse)).toBe(true);
        expect(verifyResponse.payer?.toLowerCase()).toBe(pipeline.clientAddress.toLowerCase());

        const settleResponse = await pipeline.server.settlePayment(payload, accepted);
        expect(settleResponse.success, JSON.stringify(settleResponse)).toBe(true);
        expect(settleResponse.network).toBe(NETWORK);
        expect(settleResponse.transaction).toBeDefined();
        expect(pipeline.writeContractCalls.count).toBeGreaterThan(0);

        const receipt = await pipeline.publicClient.getTransactionReceipt({
          hash: settleResponse.transaction as `0x${string}`,
        });
        const authorized = parseEventLogs({
          abi: ESCROW_EVENTS_ABI,
          eventName: "PaymentAuthorized",
          logs: receipt.logs.filter(log =>
            isAddressEqual(log.address, AUTH_CAPTURE_ESCROW_ADDRESS),
          ),
        });
        expect(authorized.length).toBeGreaterThan(0);
        expect(isAddressEqual(authorized[0]!.args.paymentInfo.operator, forwarding)).toBe(true);
      },
    );

    it("noop operator — verify rejects with no broadcast", { timeout: 60_000 }, async () => {
      const { accepted, payload } = await createCustomCollect(pipeline, noop);

      const verifyResponse = await pipeline.facilitatorClient.verify(payload, accepted);
      expect(verifyResponse.isValid).toBe(false);
      expect(verifyResponse.invalidReason).toBe(ErrSimulationFailed);
      expect(pipeline.writeContractCalls.count).toBe(0);
    });

    it("gas-wasting operator — verify rejects with no broadcast", { timeout: 60_000 }, async () => {
      const { accepted, payload } = await createCustomCollect(pipeline, gasWaster);

      const verifyResponse = await pipeline.facilitatorClient.verify(payload, accepted);
      expect(verifyResponse.isValid).toBe(false);
      expect(verifyResponse.invalidReason).toBe(ErrSimulationFailed);
      expect(pipeline.writeContractCalls.count).toBe(0);
    });
  });
});
