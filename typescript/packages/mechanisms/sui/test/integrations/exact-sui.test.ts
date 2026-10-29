/**
 * Sui testnet integration tests. They submit real transactions, so they need
 * funded keys and skip when those are missing:
 *
 *   SUI_CLIENT_PRIVATE_KEY       payer (`suiprivkey1...`), holding testnet SUI
 *   SUI_FACILITATOR_PRIVATE_KEY  gas sponsor, holding SUI in its address balance
 *   SUI_RPC_URL                  optional testnet fullnode (gRPC)
 *
 * The USDC case also needs testnet USDC (https://faucet.circle.com/) in the
 * payer's account and skips without it.
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";
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
import { beforeAll, describe, expect, it } from "vitest";
import { SUI_TESTNET_CAIP2, USDC_TESTNET } from "../../src/constants";
import { ExactSuiScheme as ExactSuiClient } from "../../src/exact/client";
import { ExactSuiScheme as ExactSuiFacilitator } from "../../src/exact/facilitator";
import { ExactSuiScheme as ExactSuiServer } from "../../src/exact/server";
import type { ExactSuiPayload, SuiExecutor } from "../../src/types";

const CLIENT_PRIVATE_KEY = process.env.SUI_CLIENT_PRIVATE_KEY;
const FACILITATOR_PRIVATE_KEY = process.env.SUI_FACILITATOR_PRIVATE_KEY;
const RPC_URL = process.env.SUI_RPC_URL ?? "https://fullnode.testnet.sui.io:443";

const NETWORK = SUI_TESTNET_CAIP2 as Network;
const SUI = "0x2::sui::SUI";
const AMOUNT = "1000"; // MIST
const TIMEOUT = 90_000;

const suiClient = new SuiGrpcClient({ network: "testnet", baseUrl: RPC_URL });
const clientKeypair = CLIENT_PRIVATE_KEY ? Ed25519Keypair.fromSecretKey(CLIENT_PRIVATE_KEY) : null;
const sponsorKeypair = FACILITATOR_PRIVATE_KEY
  ? Ed25519Keypair.fromSecretKey(FACILITATOR_PRIVATE_KEY)
  : null;

if (!clientKeypair) {
  console.warn("[exact-sui] skipped: set SUI_CLIENT_PRIVATE_KEY to run.");
} else if (!sponsorKeypair) {
  console.warn("[exact-sui] sponsored cases skipped: set SUI_FACILITATOR_PRIVATE_KEY to run.");
}

const usdcBalance = clientKeypair
  ? BigInt(
      (
        await suiClient.core.getBalance({
          owner: clientKeypair.toSuiAddress(),
          coinType: USDC_TESTNET,
        })
      ).balance.balance,
    )
  : 0n;

const describeLive = clientKeypair ? describe : describe.skip;
const itSponsored = sponsorKeypair ? it : it.skip;
const itUsdc = usdcBalance >= 10_000n ? it : it.skip;

/** Wraps an in-process facilitator for x402ResourceServer. */
class SuiFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = NETWORK;
  readonly x402Version = 2;

  /**
   * @param facilitator - The facilitator to wrap
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * @param payload - The payment payload
   * @param requirements - The payment requirements
   * @returns The verification response
   */
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.facilitator.verify(payload, requirements);
  }

  /**
   * @param payload - The payment payload
   * @param requirements - The payment requirements
   * @returns The settlement response
   */
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.facilitator.settle(payload, requirements);
  }

  /**
   * @returns The facilitator's supported kinds
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported());
  }
}

/** Co-signs as the sponsor and submits. */
const sponsorExecutor: SuiExecutor = async ({ transaction, signatures }) => {
  const { signature } = await sponsorKeypair!.signTransaction(transaction);
  return suiClient.core.executeTransaction({
    transaction,
    signatures: [...signatures, signature],
  });
};

/**
 * A facilitator scheme on testnet, sponsoring gas when asked.
 *
 * @param sponsored - Whether to advertise the sponsor as `feePayer`
 * @returns The facilitator scheme
 */
function facilitatorScheme(sponsored = false): ExactSuiFacilitator {
  return new ExactSuiFacilitator({
    clients: { [NETWORK]: suiClient },
    ...(sponsored
      ? { feePayer: sponsorKeypair!.toSuiAddress(), executeTransaction: sponsorExecutor }
      : {}),
  });
}

/**
 * A resource server backed by an in-process facilitator.
 *
 * @param scheme - The facilitator scheme
 * @returns The initialized resource server
 */
async function resourceServer(scheme: ExactSuiFacilitator): Promise<x402ResourceServer> {
  const facilitator = new x402Facilitator().register(NETWORK, scheme);
  const server = new x402ResourceServer(new SuiFacilitatorClient(facilitator));
  server.register("sui:*", new ExactSuiServer());
  await server.initialize();
  return server;
}

/**
 * An x402 client paying from the test payer; SUI is allowed past spend controls.
 *
 * @returns The client
 */
function payerClient(): x402Client {
  return x402Client.fromConfig({
    schemes: [
      {
        network: "sui:*",
        client: new ExactSuiClient(clientKeypair!, { clients: { [NETWORK]: suiClient } }),
      },
    ],
    spendControls: { allowedAssets: [{ network: NETWORK, asset: SUI }] },
  });
}

const resource = {
  url: "https://example.com/sui",
  description: "Sui test",
  mimeType: "text/plain",
};

/**
 * Requirements for a SUI payment, built by the server so facilitator extras are merged.
 *
 * @param server - The resource server
 * @param payTo - The recipient
 * @returns The single payment requirement
 */
async function suiRequirements(
  server: x402ResourceServer,
  payTo: string,
): Promise<PaymentRequirements> {
  const [requirements] = await server.buildPaymentRequirements({
    scheme: "exact",
    network: NETWORK,
    payTo,
    price: { amount: AMOUNT, asset: SUI },
  });
  return requirements;
}

/**
 * Pay `requirements` through the full x402 client path.
 *
 * @param server - The resource server
 * @param requirements - The requirement to pay
 * @returns The payment payload
 */
async function pay(
  server: x402ResourceServer,
  requirements: PaymentRequirements,
): Promise<PaymentPayload> {
  const paymentRequired = await server.createPaymentRequiredResponse([requirements], resource);
  return payerClient().createPaymentPayload(paymentRequired);
}

/**
 * Build and sign a SUI payment by hand with the given expiration.
 *
 * @param requirements - The requirement it pays
 * @param expiration - The transaction expiration
 * @returns A payment payload for `requirements`
 */
async function handBuiltPayment(
  requirements: PaymentRequirements,
  expiration: Parameters<Transaction["setExpiration"]>[0],
): Promise<PaymentPayload> {
  const tx = new Transaction();
  tx.setSender(clientKeypair!.toSuiAddress());
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [SUI],
    arguments: [
      tx.balance({ type: SUI, balance: BigInt(requirements.amount), useGasCoin: true }),
      tx.pure.address(requirements.payTo),
    ],
  });
  // Resolve against the network first, then swap the expiration offline: the
  // build-time simulation would refuse an expired window.
  const resolved = Transaction.from(await tx.build({ client: suiClient }));
  resolved.setExpiration(expiration);
  const { bytes, signature } = await clientKeypair!.signTransaction(await resolved.build());
  return { x402Version: 2, accepted: requirements, payload: { transaction: bytes, signature } };
}

/**
 * The SUI balance of an address.
 *
 * @param owner - The address
 * @returns The balance in MIST
 */
async function suiBalance(owner: string): Promise<bigint> {
  const { balance } = await suiClient.core.getBalance({ owner, coinType: SUI });
  return BigInt(balance.balance);
}

/**
 * The SUI credited to `owner` by an executed transaction.
 *
 * @param digest - The transaction digest
 * @param owner - The address
 * @returns The net SUI change for `owner`
 */
async function suiChange(digest: string, owner: string): Promise<bigint> {
  const tx = await suiClient.core.waitForTransaction({ digest, include: { balanceChanges: true } });
  const record = tx.Transaction ?? tx.FailedTransaction;
  const change = record?.balanceChanges?.find(
    c => c.address === owner && normalizeStructTag(c.coinType) === normalizeStructTag(SUI),
  );
  return BigInt(change?.amount ?? 0);
}

describeLive("Sui Integration Tests", () => {
  let currentEpoch: bigint;

  beforeAll(async () => {
    const { systemState } = await suiClient.core.getCurrentSystemState();
    currentEpoch = BigInt(systemState.epoch);
  });

  describe("self-paid", () => {
    it(
      "verifies and settles a SUI payment, then refuses to settle it again",
      { timeout: TIMEOUT },
      async () => {
        const scheme = facilitatorScheme();
        const server = await resourceServer(scheme);
        const payTo = new Ed25519Keypair().toSuiAddress();
        const requirements = await suiRequirements(server, payTo);
        expect(requirements.extra?.feePayer).toBeUndefined();

        const payload = await pay(server, requirements);
        const verified = await server.verifyPayment(payload, requirements);
        expect(verified).toMatchObject({ isValid: true, payer: clientKeypair!.toSuiAddress() });

        const settled = await server.settlePayment(payload, requirements);
        expect(settled).toMatchObject({
          success: true,
          network: NETWORK,
          payer: clientKeypair!.toSuiAddress(),
        });
        expect(await suiChange(settled.transaction, payTo)).toBe(BigInt(AMOUNT));

        const again = await scheme.settle(payload, requirements);
        expect(again).toMatchObject({ success: false, errorReason: "duplicate_settlement" });

        // A facilitator that never saw the first settle still refuses it at verify.
        const fresh = await facilitatorScheme().verify(payload, requirements);
        expect(fresh).toMatchObject({
          isValid: false,
          invalidReason: "invalid_exact_sui_payload_already_executed",
        });
      },
    );

    it(
      "rejects a payment checked against a different amount or recipient",
      { timeout: TIMEOUT },
      async () => {
        const scheme = facilitatorScheme();
        const server = await resourceServer(scheme);
        const requirements = await suiRequirements(server, new Ed25519Keypair().toSuiAddress());
        const payload = await pay(server, requirements);

        const wrongAmount = { ...requirements, amount: String(BigInt(AMOUNT) * 2n) };
        expect(await scheme.verify(payload, wrongAmount)).toMatchObject({
          isValid: false,
          invalidReason: "invalid_exact_sui_payload_transfer_mismatch",
        });

        const wrongPayTo = { ...requirements, payTo: new Ed25519Keypair().toSuiAddress() };
        expect(await scheme.verify(payload, wrongPayTo)).toMatchObject({
          isValid: false,
          invalidReason: "invalid_exact_sui_payload_transfer_mismatch",
        });
        expect(await scheme.settle(payload, wrongPayTo)).toMatchObject({
          success: false,
          errorReason: "settlement_effects_mismatch",
        });
      },
    );

    it("rejects a transaction without an expiration", { timeout: TIMEOUT }, async () => {
      const scheme = facilitatorScheme();
      const server = await resourceServer(scheme);
      const requirements = await suiRequirements(server, new Ed25519Keypair().toSuiAddress());
      const payload = await handBuiltPayment(requirements, { None: true });

      expect(await scheme.verify(payload, requirements)).toMatchObject({
        isValid: false,
        invalidReason: "invalid_exact_sui_payload_invalid_expiration",
      });
      expect(await scheme.settle(payload, requirements)).toMatchObject({
        success: false,
        errorReason: "invalid_exact_sui_payload_invalid_expiration",
      });
    });

    it("rejects a transaction whose epoch window has passed", { timeout: TIMEOUT }, async () => {
      const scheme = facilitatorScheme();
      const server = await resourceServer(scheme);
      const requirements = await suiRequirements(server, new Ed25519Keypair().toSuiAddress());
      const { chainIdentifier } = await suiClient.core.getChainIdentifier();
      const payload = await handBuiltPayment(requirements, {
        ValidDuring: {
          minEpoch: String(currentEpoch - 3n),
          maxEpoch: String(currentEpoch - 2n),
          minTimestamp: null,
          maxTimestamp: null,
          chain: chainIdentifier,
          nonce: 1,
        },
      });

      expect((await scheme.verify(payload, requirements)).isValid).toBe(false);
      expect(await scheme.settle(payload, requirements)).toMatchObject({
        success: false,
        errorReason: "invalid_exact_sui_payload_invalid_expiration",
      });
    });
  });

  describe("sponsored", () => {
    itSponsored(
      "settles with the facilitator paying gas, charging the payer only the amount",
      { timeout: TIMEOUT },
      async () => {
        const server = await resourceServer(facilitatorScheme(true));
        const payTo = new Ed25519Keypair().toSuiAddress();
        const requirements = await suiRequirements(server, payTo);
        expect(requirements.extra).toMatchObject({
          feePayer: sponsorKeypair!.toSuiAddress(),
          maxGasBudget: expect.any(String),
        });

        const payload = await pay(server, requirements);
        const tx = Transaction.from((payload.payload as ExactSuiPayload).transaction).getData();
        expect(tx.gasData.owner).toBe(sponsorKeypair!.toSuiAddress());
        expect(tx.gasData.payment).toEqual([]);

        const payer = clientKeypair!.toSuiAddress();
        const before = await suiBalance(payer);
        expect((await server.verifyPayment(payload, requirements)).isValid).toBe(true);
        const settled = await server.settlePayment(payload, requirements);
        expect(settled).toMatchObject({ success: true, payer });

        expect(await suiChange(settled.transaction, payTo)).toBe(BigInt(AMOUNT));
        expect(await suiChange(settled.transaction, payer)).toBe(-BigInt(AMOUNT));
        expect(before - (await suiBalance(payer))).toBe(BigInt(AMOUNT));
      },
    );

    itSponsored(
      "makes the client refuse a sponsor whose advertised gas cap is too low",
      { timeout: TIMEOUT },
      async () => {
        const server = await resourceServer(facilitatorScheme(true));
        const requirements = await suiRequirements(server, new Ed25519Keypair().toSuiAddress());
        const capped = { ...requirements, extra: { ...requirements.extra, maxGasBudget: "1" } };
        await expect(pay(server, capped)).rejects.toThrow("exceeds the sponsor's maxGasBudget");
      },
    );
  });

  describe("USDC", () => {
    itUsdc(
      "pays a $0.01 USDC price under the default spend controls",
      { timeout: TIMEOUT },
      async () => {
        const server = await resourceServer(facilitatorScheme());
        const payTo = new Ed25519Keypair().toSuiAddress();
        const [requirements] = await server.buildPaymentRequirements({
          scheme: "exact",
          network: NETWORK,
          payTo,
          price: "$0.01",
        });
        expect(requirements).toMatchObject({ amount: "10000", asset: USDC_TESTNET });

        const paymentRequired = await server.createPaymentRequiredResponse(
          [requirements],
          resource,
        );
        const client = new x402Client().register(
          "sui:*",
          new ExactSuiClient(clientKeypair!, { clients: { [NETWORK]: suiClient } }),
        );
        const payload = await client.createPaymentPayload(paymentRequired);
        expect((await server.verifyPayment(payload, requirements)).isValid).toBe(true);
        expect((await server.settlePayment(payload, requirements)).success).toBe(true);
      },
    );
  });

  describe("x402HTTPClient / x402HTTPResourceServer", () => {
    it("verifies and settles over the HTTP flow", { timeout: TIMEOUT }, async () => {
      const server = await resourceServer(facilitatorScheme());
      const httpServer = new x402HTTPResourceServer(server, {
        "/api/sui": {
          accepts: {
            scheme: "exact",
            network: NETWORK,
            payTo: new Ed25519Keypair().toSuiAddress(),
            price: { amount: AMOUNT, asset: SUI },
          },
          description: "Sui test",
          mimeType: "text/plain",
        },
      });
      const httpClient = new x402HTTPClient(payerClient());

      let paymentHeader: string | undefined;
      const adapter: HTTPAdapter = {
        getHeader: name => (name === "PAYMENT-SIGNATURE" ? paymentHeader : undefined),
        getMethod: () => "GET",
        getPath: () => "/api/sui",
        getUrl: () => "https://example.com/api/sui",
        getAcceptHeader: () => "application/json",
        getUserAgent: () => "TestClient/1.0",
      };
      const context = { adapter, path: "/api/sui", method: "GET" };

      const first = await httpServer.processHTTPRequest(context);
      expect(first.type).toBe("payment-error");
      const response = (first as { response: HTTPResponseInstructions }).response;
      expect(response.status).toBe(402);

      const paymentRequired = httpClient.getPaymentRequiredResponse(
        name => response.headers[name],
        response.body,
      );
      const payload = await httpClient.createPaymentPayload(paymentRequired);
      paymentHeader = (await httpClient.encodePaymentSignatureHeader(payload))["PAYMENT-SIGNATURE"];

      const second = await httpServer.processHTTPRequest(context);
      expect(second.type).toBe("payment-verified");
      const verified = second as {
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };
      const settlement = await httpServer.processSettlement(
        verified.paymentPayload,
        verified.paymentRequirements,
      );
      expect(settlement.success).toBe(true);
      if (settlement.success) {
        expect(settlement.headers["PAYMENT-RESPONSE"]).toBeDefined();
      }
    });
  });
});
