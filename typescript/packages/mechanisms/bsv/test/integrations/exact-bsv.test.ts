import { beforeAll, describe, expect, it } from "vitest";
import { Beef, PublicKey, WalletClient, Utils } from "@bsv/sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactBsvScheme as ExactBsvClient } from "../../src/exact/client/scheme";
import { ExactBsvScheme as ExactBsvFacilitator } from "../../src/exact/facilitator/scheme";
import { BRC29_PROTOCOL_ID, BSV_MAINNET_CAIP2, isBsvNetwork } from "../../src/constants";
import type { Network } from "@x402/core/types";
import type { ExactBsvPayloadV2 } from "../../src/types";

/**
 * BSV integration tests against a live BRC-100 wallet (e.g. BSV Desktop).
 *
 * Requires:
 * - BSV_INTEGRATION=true
 * - A running BRC-100 wallet reachable by WalletClient, holding a small
 *   spendable balance.
 * - Optional BSV_NETWORK (bsv:mainnet | bsv:testnet | bsv:ttn | bsv:tstn)
 *   matching the wallet's chain; defaults to bsv:mainnet.
 * - Optional BSV_ORIGINATOR for the Node HTTP wallet substrate Origin header
 *   (defaults to x402-integration.test). Required outside the browser.
 * - Optional BSV_RECIPIENT_IDENTITY_KEY for the cross-wallet payment test
 *   (defaults to a fixed test recipient). That test spends PAYMENT_SATOSHIS
 *   plus miner fees to the recipient — not a self-payment.
 */
if (process.env.BSV_INTEGRATION !== "true") {
  throw new Error(
    "BSV_INTEGRATION=true (plus a running BRC-100 wallet) is required to run the BSV integration tests.",
  );
}

const envNetwork = (process.env.BSV_NETWORK ?? BSV_MAINNET_CAIP2) as Network;
const NETWORK: Network = isBsvNetwork(envNetwork) ? envNetwork : BSV_MAINNET_CAIP2;
const ORIGINATOR = process.env.BSV_ORIGINATOR ?? "x402-integration.test";
const PAYMENT_SATOSHIS = "5";
/** External recipient identity key for the cross-wallet payment test. */
const RECIPIENT_IDENTITY_KEY =
  process.env.BSV_RECIPIENT_IDENTITY_KEY ??
  "038d013c589d475fcdd27b1436d21e53fead1e90fd7a6c9cc283234251755efbd7";

describe("exact BSV integration (self-payment round trip)", () => {
  // Node's HTTPWalletJSON substrate requires an originator Origin header.
  const wallet = new WalletClient("auto", ORIGINATOR);
  let facilitator: ExactBsvFacilitator;
  let requirements: PaymentRequirements;

  beforeAll(async () => {
    facilitator = await ExactBsvFacilitator.create({ wallet });
    requirements = {
      scheme: "exact",
      network: NETWORK,
      asset: "BSV",
      amount: PAYMENT_SATOSHIS,
      payTo: facilitator.getSigners(NETWORK)[0],
      maxTimeoutSeconds: 300,
      extra: {},
    };
  });

  it("creates, verifies, and settles a payment", async () => {
    const client = new ExactBsvClient(wallet);
    const created = await client.createPaymentPayload(2, requirements);

    const bsvPayload = created.payload as unknown as ExactBsvPayloadV2;
    expect(bsvPayload.transaction.length).toBeGreaterThan(0);
    expect(Utils.toArray(bsvPayload.transaction, "base64").length).toBeGreaterThan(0);

    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: created.payload,
    };

    const verifyResult = await facilitator.verify(paymentPayload, requirements);
    expect(verifyResult.isValid, verifyResult.invalidReason).toBe(true);

    const settleResult = await facilitator.settle(paymentPayload, requirements);
    expect(settleResult.success).toBe(true);
    expect(settleResult.transaction).toMatch(/^[0-9a-f]{64}$/);

    // A second settle of the same payment must be rejected as a replay.
    const replay = await facilitator.settle(paymentPayload, requirements);
    expect(replay.success).toBe(false);
    expect(replay.errorReason).toBe("duplicate_settlement");
  }, 120_000);
});

describe("exact BSV integration (payment to another wallet)", () => {
  // Client wallet funds a payment to an external recipient identity key.
  // Settlement requires the recipient's wallet (not available here), so this
  // test covers create + destination locking + payee-mismatch on the local
  // facilitator.
  const wallet = new WalletClient("auto", ORIGINATOR);
  let localFacilitator: ExactBsvFacilitator;
  let senderIdentityKey: string;

  beforeAll(async () => {
    localFacilitator = await ExactBsvFacilitator.create({ wallet });
    senderIdentityKey = localFacilitator.getSigners(NETWORK)[0];
  });

  it("creates a payment locked to an external recipient identity key", async () => {
    expect(RECIPIENT_IDENTITY_KEY.toLowerCase()).not.toBe(senderIdentityKey.toLowerCase());

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: NETWORK,
      asset: "BSV",
      amount: PAYMENT_SATOSHIS,
      payTo: RECIPIENT_IDENTITY_KEY,
      maxTimeoutSeconds: 300,
      extra: {},
    };

    const client = new ExactBsvClient(wallet);
    const created = await client.createPaymentPayload(2, requirements);
    const bsvPayload = created.payload as unknown as ExactBsvPayloadV2;

    expect(bsvPayload.transaction.length).toBeGreaterThan(0);
    expect(bsvPayload.senderIdentityKey.toLowerCase()).toBe(senderIdentityKey.toLowerCase());
    expect(bsvPayload.outputIndex).toBe(0);
    expect(bsvPayload.derivationPrefix.length).toBeGreaterThan(0);
    expect(bsvPayload.derivationSuffix.length).toBeGreaterThan(0);

    // Re-derive the recipient payment key the same way the client did and
    // confirm the P2PKH output pays that key for the exact amount.
    const { publicKey: derivedPubKey } = await wallet.getPublicKey({
      protocolID: BRC29_PROTOCOL_ID,
      keyID: `${bsvPayload.derivationPrefix} ${bsvPayload.derivationSuffix}`,
      counterparty: RECIPIENT_IDENTITY_KEY,
    });
    const expectedPkh = PublicKey.fromString(derivedPubKey).toHash("hex") as string;

    const beef = Beef.fromBinary(Utils.toArray(bsvPayload.transaction, "base64"));
    const subject =
      beef.atomicTxid !== undefined ? beef.findTxid(beef.atomicTxid)?.tx : beef.txs.at(-1)?.tx;
    expect(subject).toBeDefined();
    const output = subject!.outputs[bsvPayload.outputIndex];
    expect(output.satoshis).toBe(Number(PAYMENT_SATOSHIS));
    expect(output.lockingScript?.toHex().toLowerCase()).toBe(`76a914${expectedPkh}88ac`);

    // Local facilitator holds a different identity key — it must refuse
    // verify/settle for a payment it cannot take custody of.
    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: created.payload,
    };
    const verifyResult = await localFacilitator.verify(paymentPayload, requirements);
    expect(verifyResult.isValid).toBe(false);
    expect(verifyResult.invalidReason).toBe("invalid_exact_bsv_payload_payee_mismatch");

    const settleResult = await localFacilitator.settle(paymentPayload, requirements);
    expect(settleResult.success).toBe(false);
    expect(settleResult.errorReason).toBe("invalid_exact_bsv_payload_payee_mismatch");
  }, 120_000);
});
