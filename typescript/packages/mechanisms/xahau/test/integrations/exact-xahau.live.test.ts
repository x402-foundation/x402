/**
 * Live Xahau settlement check. Skipped unless a funded payer seed and a payTo
 * address are provided, so it is inert in CI and runs only when explicitly
 * configured.
 *
 * It drives the reference client and the keyless facilitator end to end
 * against a real network: the payer signs a Xahau `Payment` (paying the Xahau
 * fee), the facilitator verifies it (including simulation and signer
 * authorization) and submits it, and the payTo XAH balance must increase by
 * exactly the requested drops.
 *
 * Run (testnet):
 *   XAHAU_PAYER_SEED=s... XAHAU_LIVE_PAYTO=r... pnpm test:integration
 *
 * The e2e variable names CLIENT_XAHAU_SEED and SERVER_XAHAU_ADDRESS are
 * accepted as fallbacks, so an existing e2e/.env setup works unchanged.
 */
import { decodeSeed, ECDSA, Wallet } from "xahau";
import { describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { type FacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { XAHAU_TESTNET } from "../../src/constants";
import { ExactXahauScheme as ExactXahauClient } from "../../src/exact/client";
import { ExactXahauScheme as ExactXahauFacilitator } from "../../src/exact/facilitator";
import { ExactXahauScheme as ExactXahauServer } from "../../src/exact/server";
import { createXahauWalletSigner } from "../../src/signer";
import { createXahauClient, isXahauNetwork } from "../../src/utils";

const payerSeed = process.env.XAHAU_PAYER_SEED ?? process.env.CLIENT_XAHAU_SEED;
const payTo = process.env.XAHAU_LIVE_PAYTO ?? process.env.SERVER_XAHAU_ADDRESS;

const HAS_ACCOUNTS = Boolean(payerSeed && payTo);
const describeLive = HAS_ACCOUNTS ? describe : describe.skip;

if (!HAS_ACCOUNTS) {
  console.warn(
    "[exact-xahau.live] skipped: set XAHAU_PAYER_SEED (or CLIENT_XAHAU_SEED) and XAHAU_LIVE_PAYTO (or SERVER_XAHAU_ADDRESS) to run.",
  );
}

const network = (process.env.XAHAU_LIVE_NETWORK ?? XAHAU_TESTNET) as Network;
const amount = process.env.XAHAU_LIVE_AMOUNT ?? "10"; // drops
const invoiceId = "exact-xahau-live-test";

/**
 * In-process facilitator client that adapts the reference facilitator for the
 * resource server used in this live test.
 */
class XahauFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = network;
  readonly x402Version = 2;

  /**
   * Creates the adapter around a configured x402 facilitator.
   *
   * @param facilitator - Facilitator with the Xahau exact scheme registered
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * Verifies a payment payload through the wrapped facilitator.
   *
   * @param paymentPayload - x402 payment payload
   * @param paymentRequirements - Payment requirements
   * @returns Verification response
   */
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  /**
   * Settles a payment payload through the wrapped facilitator.
   *
   * @param paymentPayload - x402 payment payload
   * @param paymentRequirements - Payment requirements
   * @returns Settlement response
   */
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  /**
   * Reports the wrapped facilitator's supported kinds.
   *
   * @returns Supported response
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported());
  }
}

/**
 * Reads the XAH balance of an account in drops from the validated ledger.
 *
 * @param account - Xahau classic address
 * @returns Balance in drops
 */
async function getXahBalanceDrops(account: string): Promise<bigint> {
  if (!isXahauNetwork(network)) {
    throw new Error(`Unsupported Xahau network: ${network}`);
  }
  const client = createXahauClient(network, {});
  try {
    await client.connect();
    const response = await client.request({
      command: "account_info",
      account,
      ledger_index: "validated",
    });
    return BigInt(response.result.account_data.Balance);
  } finally {
    await client.disconnect();
  }
}

describeLive("Xahau exact live settlement", () => {
  it("settles a real payer-signed Payment and delivers the exact drops", async () => {
    const algorithm = decodeSeed(payerSeed!).type === "ed25519" ? ECDSA.ed25519 : ECDSA.secp256k1;
    const payerWallet = Wallet.fromSeed(payerSeed!, { algorithm });

    const client = x402Client.fromConfig({
      schemes: [{ network, client: new ExactXahauClient(createXahauWalletSigner(payerWallet)) }],
      spendControls: { allowedAssets: [{ network, asset: "XAH" }] },
    });
    const facilitator = new x402Facilitator().register(network, new ExactXahauFacilitator());
    const server = new x402ResourceServer(new XahauFacilitatorClient(facilitator));
    server.register(network, new ExactXahauServer());
    await server.initialize();

    const before = await getXahBalanceDrops(payTo!);

    const accepts: PaymentRequirements[] = [
      {
        scheme: "exact",
        network,
        asset: "XAH",
        payTo: payTo!,
        amount,
        maxTimeoutSeconds: 120,
        extra: { areFeesSponsored: false, invoiceId },
      } as PaymentRequirements,
    ];
    const resource = {
      url: "https://example.com/weather",
      description: "Weather data",
      mimeType: "application/json",
    };

    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    const accepted = server.findMatchingRequirements(paymentRequired.accepts, paymentPayload);
    expect(accepted).toBeDefined();

    const verify = await server.verifyPayment(paymentPayload, accepted!);
    expect(verify.isValid).toBe(true);
    expect(verify.payer).toBe(payerWallet.classicAddress);

    const settle = await server.settlePayment(paymentPayload, accepted!);
    expect(settle.success).toBe(true);
    expect(settle.transaction).toMatch(/^[A-F0-9]{64}$/);

    const after = await getXahBalanceDrops(payTo!);
    expect(after - before).toBe(BigInt(amount));

    console.log(
      `[exact-xahau.live] settled ${amount} drops on ${network}; tx=${settle.transaction}; payTo ${before} -> ${after}`,
    );
  }, 120_000);
});
