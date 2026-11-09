/**
 * Live NEAR settlement check. Skipped unless payer + relayer keys are provided,
 * so it is inert in CI and runs only when explicitly configured.
 *
 * It drives the reference client and facilitator signers end to end against a
 * real network: the payer signs a NEP-366 `SignedDelegate`, the relayer submits
 * it, and a real NEP-141 `ft_transfer` settles on chain. The payTo balance must
 * increase by exactly the requested amount.
 *
 * Run (testnet):
 *   NEAR_PAYER_ACCOUNT_ID=mike.testnet NEAR_PAYER_PRIVATE_KEY=ed25519:... \
 *   NEAR_RELAYER_ACCOUNT_ID=relayer.mike.testnet NEAR_RELAYER_PRIVATE_KEY=ed25519:... \
 *   pnpm test:integration
 */
import type { KeyPairString } from "@near-js/crypto";
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
import { NEAR_TESTNET_CAIP2 } from "../../src/constants";
import { ExactNearScheme as ExactNearClient } from "../../src/exact/client";
import { ExactNearScheme as ExactNearFacilitator } from "../../src/exact/facilitator";
import { ExactNearScheme as ExactNearServer } from "../../src/exact/server";
import { createClientNearSigner } from "../../src/signers/clientNearSigner";
import { createFacilitatorNearSigner } from "../../src/signers/facilitatorNearSigner";

const payerId = process.env.NEAR_PAYER_ACCOUNT_ID;
const payerKey = process.env.NEAR_PAYER_PRIVATE_KEY as KeyPairString | undefined;
const relayerId = process.env.NEAR_RELAYER_ACCOUNT_ID;
const relayerKey = process.env.NEAR_RELAYER_PRIVATE_KEY as KeyPairString | undefined;

const HAS_KEYS = Boolean(payerId && payerKey && relayerId && relayerKey);
const describeLive = HAS_KEYS ? describe : describe.skip;

if (!HAS_KEYS) {
  console.warn(
    "[exact-near.live] skipped: set NEAR_PAYER_ACCOUNT_ID/_PRIVATE_KEY and NEAR_RELAYER_ACCOUNT_ID/_PRIVATE_KEY to run.",
  );
}

// Circle USDC on NEAR testnet (6 decimals); override for other tokens/networks.
const network = (process.env.NEAR_LIVE_NETWORK ?? NEAR_TESTNET_CAIP2) as Network;
const asset =
  process.env.NEAR_LIVE_ASSET ?? "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const payTo = process.env.NEAR_LIVE_PAYTO ?? "merchant.mike.testnet";
const amount = process.env.NEAR_LIVE_AMOUNT ?? "1000"; // 0.001 USDC

class NearFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = network;
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

describeLive("NEAR exact live settlement", () => {
  it("settles a real ft_transfer from payer to payTo via the relayer", async () => {
    const facilitatorSigner = createFacilitatorNearSigner({
      relayers: [{ accountId: relayerId!, secretKey: relayerKey! }],
    });

    const client = new x402Client().register(
      network,
      new ExactNearClient(createClientNearSigner({ accountId: payerId!, secretKey: payerKey! })),
    );
    const facilitator = new x402Facilitator().register(
      network,
      new ExactNearFacilitator(facilitatorSigner),
    );
    const server = new x402ResourceServer(new NearFacilitatorClient(facilitator));
    server.register(network, new ExactNearServer());
    await server.initialize();

    const before = await facilitatorSigner.ftBalanceOf({ network, token: asset, accountId: payTo });

    const accepts: PaymentRequirements[] = [
      {
        scheme: "exact",
        network,
        asset,
        payTo,
        amount,
        maxTimeoutSeconds: 120,
        extra: {},
      } as PaymentRequirements,
    ];
    const resource = {
      url: "https://example.com/weather",
      description: "Weather data",
      mimeType: "application/json",
    };

    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    const accepted = server.findMatchingRequirements(accepts, paymentPayload);
    expect(accepted).toBeDefined();

    const verify = await server.verifyPayment(paymentPayload, accepted!);
    expect(verify.isValid).toBe(true);
    expect(verify.payer).toBe(payerId);

    const settle = await server.settlePayment(paymentPayload, accepted!);
    expect(settle.success).toBe(true);
    expect(settle.transaction).toBeTruthy();

    const after = await facilitatorSigner.ftBalanceOf({ network, token: asset, accountId: payTo });
    expect(after - before).toBe(BigInt(amount));

    console.log(
      `[exact-near.live] settled ${amount} on ${network}; tx=${settle.transaction}; payTo ${before} -> ${after}`,
    );
  }, 60_000);
});
