/**
 * Env-gated live `transferExecutor` settlement on Hedera testnet.
 *
 * The suite is skipped unless every required variable below is set, in the
 * shell or in `.env.test` (see README "Live Integration Testing"). When it is
 * skipped, no Hedera client is built and no request is sent.
 *
 * Required:
 * - `HEDERA_FACILITATOR_ACCOUNT_ID`: fee payer that submits the contract call
 * - `HEDERA_FACILITATOR_PRIVATE_KEY`: its ECDSA key
 * - `HEDERA_RESOURCE_SERVER_ACCOUNT_ID`: `payTo`
 * - `HEDERA_TE_EXECUTOR_ID`: admitted executor contract id (`0.0.x`)
 * - `HEDERA_TE_PAYER_ACCOUNT_ID`: account the executor debits (`payload.payer`)
 * - `HEDERA_TE_AUTHORIZATION`: 0x-hex authorization prepared for exactly this
 *   payer, asset, `payTo` and amount, unexpired and not yet consumed
 * - `HEDERA_TE_AMOUNT`: amount in the asset's smallest unit (tinybars for HBAR)
 *
 * Optional:
 * - `HEDERA_TE_ASSET`: `0.0.0` (HBAR, default) or an HTS token id
 * - `HEDERA_TE_GAS_LIMIT`: gas for simulation and submission (default 400000)
 * - `HEDERA_MIRROR_NODE_URL`: Mirror Node base URL (default: the public testnet mirror)
 *
 * On success it prints the Hashscan link of the settlement transaction.
 */
import { describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer, FacilitatorClient } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";
import {
  type ClientHederaSigner,
  type FacilitatorHederaSigner,
  createHederaSignAndSubmitTransaction,
  createHederaVerifyPayerSignature,
} from "../../src/signer";
import { createHederaPreflightTransfer } from "../../src/preflight";
import {
  createHederaGetTokenCustomFees,
  createHederaGetTransactionRecord,
  createHederaResolveEvmAddress,
  createHederaSimulateContractCall,
  createHederaSubmitContractExecute,
} from "../../src/transferExecutorCapabilities";
import { ExactHederaScheme as ExactHederaClient } from "../../src/exact/client/scheme";
import { ExactHederaScheme as ExactHederaServer } from "../../src/exact/server/scheme";
import { ExactHederaScheme as ExactHederaFacilitator } from "../../src/exact/facilitator/scheme";
import { HBAR_ASSET_ID } from "../../src/constants";

const DEFAULT_GAS_LIMIT = 400_000;

class HederaFacilitatorClient implements FacilitatorClient {
  /**
   * Every settle response, in order. Core retries a `settlement_pending` once, and the retry
   * re-reads the same transaction's record, submitting nothing.
   */
  readonly settleResponses: SettleResponse[] = [];

  constructor(private readonly facilitator: x402Facilitator) {}

  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const response = await this.facilitator.settle(paymentPayload, paymentRequirements);
    this.settleResponses.push(response);
    return response;
  }

  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported() as SupportedResponse);
  }
}

/**
 * Parses an ECDSA private key from an env var.
 *
 * @param name - Env var name, for the error message
 * @param value - Raw key string
 * @returns The parsed key
 */
function parseEcdsaPrivateKeyFromEnv(name: string, value: string): PrivateKey {
  try {
    return PrivateKey.fromStringECDSA(value);
  } catch {
    throw new Error(
      `${name} must be a valid ECDSA private key string (0x-prefixed raw key or DER-encoded key).`,
    );
  }
}

/**
 * Builds the Hashscan testnet link of a transaction.
 *
 * @param transactionId - Transaction id in the SDK `0.0.x@seconds.nanos` form
 * @returns Hashscan URL with the dash-form id
 */
function hashscanTestnetUrl(transactionId: string): string {
  const match = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(transactionId);
  const id = match ? `${match[1]}-${match[2]}-${match[3].padStart(9, "0")}` : transactionId;
  return `https://hashscan.io/testnet/transaction/${id}`;
}

describe("Hedera transferExecutor integration", () => {
  const feePayerAccount = process.env.HEDERA_FACILITATOR_ACCOUNT_ID;
  const feePayerPrivateKeyRaw = process.env.HEDERA_FACILITATOR_PRIVATE_KEY;
  const resourceServerAccount = process.env.HEDERA_RESOURCE_SERVER_ACCOUNT_ID;
  const executorId = process.env.HEDERA_TE_EXECUTOR_ID;
  const payerAccount = process.env.HEDERA_TE_PAYER_ACCOUNT_ID;
  const authorization = process.env.HEDERA_TE_AUTHORIZATION;
  const amount = process.env.HEDERA_TE_AMOUNT;
  const hasLiveEnv = Boolean(
    feePayerAccount &&
      feePayerPrivateKeyRaw &&
      resourceServerAccount &&
      executorId &&
      payerAccount &&
      authorization &&
      amount,
  );

  describe.skipIf(!hasLiveEnv)("Live Hedera testnet settlement (env-gated)", () => {
    it("verifies and settles through an admitted executor", async () => {
      const network = "hedera:testnet" as Network;
      const asset = process.env.HEDERA_TE_ASSET || HBAR_ASSET_ID;
      const gasLimit = process.env.HEDERA_TE_GAS_LIMIT
        ? Number(process.env.HEDERA_TE_GAS_LIMIT)
        : DEFAULT_GAS_LIMIT;
      const mirrorNodeUrl = process.env.HEDERA_MIRROR_NODE_URL || undefined;
      const mirror = { mirrorNodeUrl };
      const feePayerPrivateKey = parseEcdsaPrivateKeyFromEnv(
        "HEDERA_FACILITATOR_PRIVATE_KEY",
        feePayerPrivateKeyRaw!,
      );

      const buildClient = (clientNetwork: string): Client => {
        const client =
          clientNetwork === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet();
        client.setOperator(AccountId.fromString(feePayerAccount!), feePayerPrivateKey);
        return client;
      };
      // The default capabilities; the cryptoTransfer ones are required by the signer type.
      const facilitatorSigner: FacilitatorHederaSigner = {
        getAddresses: () => [feePayerAccount!],
        signAndSubmitTransaction: createHederaSignAndSubmitTransaction(
          buildClient,
          feePayerPrivateKey,
        ),
        verifyPayerSignature: createHederaVerifyPayerSignature(mirror),
        preflightTransfer: createHederaPreflightTransfer(mirror),
        resolveEvmAddress: createHederaResolveEvmAddress(mirror),
        getTokenCustomFees: createHederaGetTokenCustomFees(mirror),
        simulateContractCall: createHederaSimulateContractCall(mirror),
        submitContractExecute: createHederaSubmitContractExecute(buildClient, feePayerPrivateKey),
        getTransactionRecord: createHederaGetTransactionRecord(mirror),
      };
      const facilitator = new x402Facilitator().register(
        network,
        new ExactHederaFacilitator(facilitatorSigner, {
          transferExecutor: { executors: { [network]: [executorId!] }, gasLimit },
        }),
      );
      const facilitatorClient = new HederaFacilitatorClient(facilitator);
      const server = new x402ResourceServer(facilitatorClient);
      server.register(network, new ExactHederaServer());
      await server.initialize();

      // A transferExecutor-only signer: the hook hands over the prepared authorization.
      const clientSigner: ClientHederaSigner = {
        accountId: payerAccount!,
        createPartiallySignedTransferTransaction: async () => {
          throw new Error("this payer pays with transferExecutor only");
        },
        createTransferExecutorAuthorization: async () => ({
          executor: executorId!,
          authorization: authorization!,
        }),
      };
      // spendControls would reject the non-default HBAR asset 0.0.0.
      const client = new x402Client()
        .setSpendControls(false)
        .register(network, new ExactHederaClient(clientSigner));

      const accepts = await server.buildPaymentRequirements({
        scheme: "exact",
        network,
        payTo: resourceServerAccount!,
        price: { amount: amount!, asset },
        maxTimeoutSeconds: 180,
        extra: { assetTransferMethod: "transferExecutor" },
      });
      expect(accepts[0].extra).toMatchObject({
        assetTransferMethod: "transferExecutor",
        executors: [executorId],
      });
      const resource = {
        url: "https://example.com/paid",
        description: "Live Hedera transferExecutor settle",
        mimeType: "application/json",
      };

      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      expect(paymentPayload.payload).toEqual({
        payer: payerAccount,
        executor: executorId,
        authorization,
      });
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid, JSON.stringify(verifyResponse)).toBe(true);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      const submitted = facilitatorClient.settleResponses.find(response => response.transaction);
      if (submitted) {
        console.log(`Hashscan: ${hashscanTestnetUrl(submitted.transaction)}`);
      }
      expect(settleResponse.success, JSON.stringify(settleResponse)).toBe(true);
      expect(settleResponse.transaction.length).toBeGreaterThan(0);
    });
  });
});
