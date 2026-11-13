import { rpc, scValToNative } from "@stellar/stellar-sdk";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { FacilitatorClient, x402ResourceServer } from "@x402/core/server";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEd25519Signer, Ed25519Signer, STELLAR_TESTNET_CAIP2 } from "../../src";
import { UptoStellarScheme as UptoStellarClient } from "../../src/upto/client";
import { UptoStellarScheme as UptoStellarFacilitator } from "../../src/upto/facilitator";
import { UptoStellarScheme as UptoStellarServer } from "../../src/upto/server";
import type { UptoStellarPayload } from "../../src/upto";

// The same four testnet accounts as the exact integration test
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY as string;
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY as string;
const FACILITATOR_ADDRESS = process.env.FACILITATOR_ADDRESS as string;
const RESOURCE_SERVER_ADDRESS = process.env.RESOURCE_SERVER_ADDRESS as string;
// Native XLM's Stellar Asset Contract: every funded account can pay it without a trustline
const XLM_TESTNET_ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";

const missingEnvVars =
  !CLIENT_PRIVATE_KEY ||
  !FACILITATOR_PRIVATE_KEY ||
  !FACILITATOR_ADDRESS ||
  !RESOURCE_SERVER_ADDRESS;

const resource = {
  url: "https://company.co/metered",
  description: "Metered resource",
  mimeType: "application/json",
};

/**
 * Funds an account with Friendbot when it does not exist yet.
 *
 * @param address - The account to fund
 */
async function fundOneAccount(address: string): Promise<void> {
  const res = await fetch(`${HORIZON_TESTNET}/accounts/${address}`);
  if (res.status === 404) {
    const fb = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`);
    if (!fb.ok) throw new Error(`Friendbot failed for ${address}: ${fb.status}`);
  } else if (!res.ok) {
    throw new Error(`Horizon account check failed for ${address}: ${res.status}`);
  }
}

/**
 * Reads the `upto_settled` event of a settlement transaction.
 *
 * @param hash - The settlement transaction hash
 * @returns The settled amount and maximum, and the settlement authority
 */
async function settledEvent(
  hash: string,
): Promise<{ amount: bigint; max: bigint; facilitator: string }> {
  const server = new rpc.Server(TESTNET_RPC);
  const result = await server.pollTransaction(hash, { attempts: 30 });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${hash} is ${result.status}`);
  }
  for (const event of result.events.contractEventsXdr.flat()) {
    const body = event.body().v0();
    if (scValToNative(body.topics()[0]) !== "upto_settled") continue;
    const data = scValToNative(body.data()) as {
      amount: bigint;
      max_amount: bigint;
      facilitator: string;
    };
    return { amount: data.amount, max: data.max_amount, facilitator: data.facilitator };
  }
  throw new Error(`transaction ${hash} emitted no upto_settled event`);
}

/**
 * Stellar Facilitator Client wrapper
 * Wraps the x402Facilitator for use with x402ResourceServer
 */
class StellarFacilitatorClient implements FacilitatorClient {
  readonly scheme = "upto";
  readonly network = STELLAR_TESTNET_CAIP2;
  readonly x402Version = 2;

  /**
   * Creates a new StellarFacilitatorClient instance
   *
   * @param facilitator - The x402 facilitator to wrap
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * Verifies a payment payload
   *
   * @param paymentPayload - The payment payload to verify
   * @param paymentRequirements - The payment requirements
   * @returns Promise resolving to verification response
   */
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  /**
   * Settles a payment
   *
   * @param paymentPayload - The payment payload to settle
   * @param paymentRequirements - The payment requirements
   * @returns Promise resolving to settlement response
   */
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  /**
   * Gets supported payment kinds
   *
   * @returns Promise resolving to supported response
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported() as SupportedResponse);
  }
}

describe.skipIf(missingEnvVars)("Stellar upto integration tests", () => {
  let clientSigner: Ed25519Signer;
  let facilitatorSigner: Ed25519Signer;
  let client: x402Client;
  let server: x402ResourceServer;

  /**
   * Requirements for a payment of up to `amount` stroops of XLM.
   *
   * @param amount - The maximum, in stroops
   * @returns The payment requirements
   */
  function requirements(amount: string): PaymentRequirements {
    return {
      scheme: "upto",
      network: STELLAR_TESTNET_CAIP2,
      asset: XLM_TESTNET_ASSET,
      amount,
      payTo: RESOURCE_SERVER_ADDRESS,
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true, facilitatorAddress: facilitatorSigner.address },
    };
  }

  /**
   * Has the client pay for `accepts` and returns the payload with the requirements it accepted.
   *
   * @param accepts - The payment requirements
   * @returns The payment payload and the matching requirements
   */
  async function pay(
    accepts: PaymentRequirements[],
  ): Promise<{ payload: PaymentPayload; accepted: PaymentRequirements }> {
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
    const payload = await client.createPaymentPayload(paymentRequired);
    const accepted = server.findMatchingRequirements(accepts, payload);
    if (accepted === undefined) throw new Error("no requirements match the payload");
    return { payload, accepted };
  }

  beforeAll(async () => {
    clientSigner = createEd25519Signer(CLIENT_PRIVATE_KEY, STELLAR_TESTNET_CAIP2);
    facilitatorSigner = createEd25519Signer(FACILITATOR_PRIVATE_KEY, STELLAR_TESTNET_CAIP2);
    await Promise.all(
      [FACILITATOR_ADDRESS, RESOURCE_SERVER_ADDRESS, clientSigner.address].map(fundOneAccount),
    );
  });

  beforeEach(async () => {
    // Default spend controls reject the XLM test asset before the payment reaches the Stellar
    // scheme; this test covers the scheme and facilitator, not spend controls.
    client = new x402Client()
      .setSpendControls(false)
      .register(STELLAR_TESTNET_CAIP2, new UptoStellarClient(clientSigner));
    const facilitator = new x402Facilitator().register(
      STELLAR_TESTNET_CAIP2,
      new UptoStellarFacilitator([facilitatorSigner]),
    );
    server = new x402ResourceServer(new StellarFacilitatorClient(facilitator));
    server.register(STELLAR_TESTNET_CAIP2, new UptoStellarServer());
    await server.initialize();
  });

  it("verifies the maximum and settles part of it on the testnet contract", async () => {
    const { payload, accepted } = await pay([requirements("100000")]);
    expect(payload.accepted.scheme).toBe("upto");
    const body = payload.payload as unknown as UptoStellarPayload;
    expect(typeof body.authorization).toBe("string");

    const verified = await server.verifyPayment(payload, accepted);
    expect(verified.isValid).toBe(true);
    expect(verified.payer).toBe(clientSigner.address);

    const settled = await server.settlePayment(payload, accepted, undefined, undefined, {
      amount: "25%",
    });
    expect(settled.success).toBe(true);
    expect(settled.amount).toBe("25000");
    expect(settled.payer).toBe(clientSigner.address);
    expect(settled.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(await settledEvent(settled.transaction)).toEqual({
      amount: 25000n,
      max: 100000n,
      facilitator: facilitatorSigner.address,
    });

    // The same authorization is never settled twice, and never for another amount.
    const repeated = await server.settlePayment(payload, accepted, undefined, undefined, {
      amount: "25%",
    });
    expect(repeated.transaction).toBe(settled.transaction);
    const different = await server.settlePayment(payload, accepted, undefined, undefined, {
      amount: "50%",
    });
    expect(different.success).toBe(false);
    expect(different.errorReason).toBe("settle_upto_stellar_idempotency_conflict");
  }, 60_000);

  it("settles zero on-chain without moving funds", async () => {
    const { payload, accepted } = await pay([requirements("100000")]);
    const settled = await server.settlePayment(payload, accepted, undefined, undefined, {
      amount: "0",
    });
    expect(settled.success).toBe(true);
    expect(settled.amount).toBe("0");
    expect((await settledEvent(settled.transaction)).amount).toBe(0n);
  }, 60_000);

  it("refuses to settle more than the maximum", async () => {
    const { payload, accepted } = await pay([requirements("100000")]);
    const settled = await server.settlePayment(payload, accepted, undefined, undefined, {
      amount: "100001",
    });
    expect(settled.success).toBe(false);
    expect(settled.errorReason).toBe("invalid_upto_stellar_payload_settlement_exceeds_amount");
  });
});
