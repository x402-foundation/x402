/**
 * Live XRPL settlement check. Skipped unless a funded payer seed and a payTo
 * address are provided, so it is inert in CI and runs only when explicitly
 * configured.
 *
 * It drives the reference client and the keyless facilitator end to end
 * against a real network: the payer signs an XRPL `Payment` (paying the XRPL
 * fee), the facilitator verifies it (including simulation and signer
 * authorization) and submits it, and the payTo XRP balance must increase by
 * exactly the requested drops.
 *
 * Run (testnet):
 *   XRPL_PAYER_SEED=s... XRPL_LIVE_PAYTO=r... pnpm test:integration
 *
 * The e2e variable names CLIENT_XRPL_SEED and SERVER_XRPL_ADDRESS are
 * accepted as fallbacks, so an existing e2e/.env setup works unchanged.
 */
import { Wallet } from "xrpl";
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
import { XRPL_TESTNET } from "../../src/constants";
import { ExactXrplScheme as ExactXrplClient } from "../../src/exact/client";
import { ExactXrplScheme as ExactXrplFacilitator } from "../../src/exact/facilitator";
import { ExactXrplScheme as ExactXrplServer } from "../../src/exact/server";
import { createXrplWalletSigner } from "../../src/signer";
import { createXrplClient, isXrplNetwork } from "../../src/utils";

const payerSeed = process.env.XRPL_PAYER_SEED ?? process.env.CLIENT_XRPL_SEED;
const payTo = process.env.XRPL_LIVE_PAYTO ?? process.env.SERVER_XRPL_ADDRESS;

const HAS_ACCOUNTS = Boolean(payerSeed && payTo);
const describeLive = HAS_ACCOUNTS ? describe : describe.skip;

if (!HAS_ACCOUNTS) {
  console.warn(
    "[exact-xrpl.live] skipped: set XRPL_PAYER_SEED (or CLIENT_XRPL_SEED) and XRPL_LIVE_PAYTO (or SERVER_XRPL_ADDRESS) to run.",
  );
}

const network = (process.env.XRPL_LIVE_NETWORK ?? XRPL_TESTNET) as Network;
const amount = process.env.XRPL_LIVE_AMOUNT ?? "10"; // drops
const invoiceId = "exact-xrpl-live-test";

/**
 * In-process facilitator client that adapts the reference facilitator for the
 * resource server used in this live test.
 */
class XrplFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = network;
  readonly x402Version = 2;

  /**
   * Creates the adapter around a configured x402 facilitator.
   *
   * @param facilitator - Facilitator with the XRPL exact scheme registered
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
 * Reads the XRP balance of an account in drops from the validated ledger.
 *
 * @param account - XRPL classic address
 * @returns Balance in drops
 */
async function getXrpBalanceDrops(account: string): Promise<bigint> {
  if (!isXrplNetwork(network)) {
    throw new Error(`Unsupported XRPL network: ${network}`);
  }
  const client = createXrplClient(network, {});
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

describeLive("XRPL exact live settlement", () => {
  it("settles a real payer-signed Payment and delivers the exact drops", async () => {
    const payerWallet = Wallet.fromSeed(payerSeed!);

    const client = new x402Client().register(
      network,
      new ExactXrplClient(createXrplWalletSigner(payerWallet)),
    );
    const facilitator = new x402Facilitator().register(network, new ExactXrplFacilitator());
    const server = new x402ResourceServer(new XrplFacilitatorClient(facilitator));
    server.register(network, new ExactXrplServer());
    await server.initialize();

    const before = await getXrpBalanceDrops(payTo!);

    const accepts: PaymentRequirements[] = [
      {
        scheme: "exact",
        network,
        asset: "XRP",
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

    const after = await getXrpBalanceDrops(payTo!);
    expect(after - before).toBe(BigInt(amount));

    console.log(
      `[exact-xrpl.live] settled ${amount} drops on ${network}; tx=${settle.transaction}; payTo ${before} -> ${after}`,
    );
  }, 120_000);
});
