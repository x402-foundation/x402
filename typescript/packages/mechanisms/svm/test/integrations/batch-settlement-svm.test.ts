import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { FacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { beforeAll, describe, expect, it } from "vitest";

import { BatchSvmScheme as BatchClientScheme } from "../../src/batch-settlement/client/scheme";
import { BatchSvmScheme as BatchFacilitatorScheme } from "../../src/batch-settlement/facilitator/scheme";
import { BatchSvmScheme as BatchServerScheme } from "../../src/batch-settlement/server/scheme";
import { BatchChannelManager } from "../../src/batch-settlement/server/channelManager";
import { MemoryChannelStore } from "../../src/batch-settlement/server/storage";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import { fetchMaybeChannel } from "../../src/payment-channels/generated/accounts/channel";
import { ChannelStatus } from "../../src/payment-channels/generated/types/channelStatus";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "../../src/payment-channels/onchain";
import { toFacilitatorSvmSigner } from "../../src/signer";
import { createRpcClient } from "../../src/utils";

/**
 * A local Surfnet (`surfpool start --network devnet`) serves both the deployed
 * payment-channels program and the devnet USDC mint, and its cheatcodes fund
 * accounts without faucets — so this runs the real onchain flow with no
 * pre-provisioned keys. Point `SVM_RPC_URL` at any RPC that has the program.
 */
const RPC_URL = process.env.SVM_RPC_URL ?? "http://127.0.0.1:8899";
const NETWORK: Network = SOLANA_DEVNET_CAIP2;
const PRICE = "1000";
const DEPOSIT = "10000";
const WITHDRAW_DELAY = 900;

/** Whether the RPC is up and actually carries the payment-channels program. */
async function chainIsReady(): Promise<boolean> {
  try {
    const rpc = createRpcClient(NETWORK, RPC_URL);
    const program = await rpc
      .getAccountInfo(PAYMENT_CHANNELS_PROGRAM_ID, { encoding: "base64" })
      .send();
    if (!program.value?.executable) return false;
    const mint = await rpc
      .getAccountInfo(USDC_DEVNET_ADDRESS as never, { encoding: "base64" })
      .send();
    return mint.value !== null;
  } catch {
    return false;
  }
}

const ready = await chainIsReady();
if (!ready) {
  console.warn(
    `[batch-settlement-svm] skipping: no payment-channels program at ${RPC_URL}. ` +
      "Start one with: surfpool start --network devnet --no-deploy",
  );
}
const describeOnChain = ready ? describe : describe.skip;

/** Call a Surfnet cheatcode. */
async function cheat(method: string, params: unknown[]): Promise<void> {
  const response = await fetch(RPC_URL, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as { error?: { message?: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message ?? "unknown"}`);
}

/** Give `address` lamports to pay rent and fees with. */
async function fundSol(address: string, lamports: number): Promise<void> {
  await cheat("surfnet_setAccount", [
    address,
    { data: "", executable: false, lamports, owner: "11111111111111111111111111111111" },
  ]);
}

/** Give `address` a USDC balance to escrow. */
async function fundUsdc(address: string, amount: number): Promise<void> {
  await cheat("surfnet_setTokenAccount", [
    address,
    USDC_DEVNET_ADDRESS,
    { amount },
    TOKEN_PROGRAM_ADDRESS,
  ]);
}

/** The owner's USDC balance in base units, or 0 when it holds no account. */
async function usdcBalance(owner: string): Promise<bigint> {
  const response = await fetch(RPC_URL, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "getTokenAccountsByOwner",
      params: [owner, { mint: USDC_DEVNET_ADDRESS }, { encoding: "jsonParsed" }],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as {
    result?: {
      value?: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[];
    };
  };
  return (body.result?.value ?? []).reduce(
    (total, row) => total + BigInt(row.account.data.parsed.info.tokenAmount.amount),
    0n,
  );
}

/** Wraps the in-process facilitator so the resource server can call it. */
class SvmFacilitatorClient implements FacilitatorClient {
  /** @param facilitator - The facilitator to wrap */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * @param payload - Payment payload to verify
   * @param requirements - Requirements to verify against
   * @returns The facilitator's verification result
   */
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.facilitator.verify(payload, requirements);
  }

  /**
   * @param payload - Payment payload to settle
   * @param requirements - Requirements to settle against
   * @returns The facilitator's settlement result
   */
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.facilitator.settle(payload, requirements);
  }

  /** @returns The payment kinds the facilitator supports */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported());
  }
}

describe("batch-settlement SVM onchain", () => {
  describeOnChain("open, pay, top up, redeem, refund", () => {
    let payer: KeyPairSigner;
    let operator: KeyPairSigner;
    let receiver: KeyPairSigner;

    beforeAll(async () => {
      payer = await generateKeyPairSigner();
      operator = await generateKeyPairSigner();
      receiver = await generateKeyPairSigner();
      await fundSol(payer.address, 10_000_000_000);
      await fundSol(operator.address, 10_000_000_000);
      await fundSol(receiver.address, 10_000_000_000);
      await fundUsdc(payer.address, 1_000_000);
      // The payout destinations must exist before an escrow is accepted.
      await fundUsdc(operator.address, 0);
      await fundUsdc(receiver.address, 0);
      lifecycleClient = new BatchClientScheme(payer, {
        depositAmount: DEPOSIT,
        rpcUrl: RPC_URL,
      });
    });

    /** The client that owns the channel through the lifecycle stages. */
    let lifecycleClient: BatchClientScheme;

    /**
     * A pipeline over `store`, using the lifecycle client unless a cold one is
     * asked for — a fresh client has no local record and rediscovers.
     */
    function pipeline(store = new MemoryChannelStore(), coldClient = false) {
      const facilitator = new x402Facilitator().register(
        NETWORK,
        new BatchFacilitatorScheme(toFacilitatorSvmSigner(operator, { defaultRpcUrl: RPC_URL }), {
          rpcUrl: RPC_URL,
        }),
      );
      const server = new x402ResourceServer(new SvmFacilitatorClient(facilitator));
      server.register(NETWORK, new BatchServerScheme({ store, withdrawDelay: WITHDRAW_DELAY }));
      const clientScheme = coldClient
        ? new BatchClientScheme(payer, { depositAmount: DEPOSIT, rpcUrl: RPC_URL })
        : lifecycleClient;
      const client = new x402Client().register(NETWORK, clientScheme);
      return { client, clientScheme, server, store };
    }

    function accepts(): PaymentRequirements[] {
      return [
        {
          amount: PRICE,
          asset: USDC_DEVNET_ADDRESS,
          extra: {
            feePayer: operator.address,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
            withdrawDelay: WITHDRAW_DELAY,
          },
          maxTimeoutSeconds: 300,
          network: NETWORK,
          payTo: receiver.address,
          scheme: "batch-settlement",
        },
      ];
    }

    const resource = { url: "https://example.test/paid" };

    /** The channel this suite opens, and the server state that tracks it. */
    let channelId: string;
    let lifecycleStore: MemoryChannelStore;

    it(
      "opens a channel, serves a paid request, and charges it once",
      { timeout: 120_000 },
      async () => {
        lifecycleStore = new MemoryChannelStore();
        const { client, clientScheme, server, store } = pipeline(lifecycleStore);
        await server.initialize();

        const required = await server.createPaymentRequiredResponse(accepts(), resource);
        const payload = await client.createPaymentPayload(required);
        expect((payload.payload as { type: string }).type).toBe("deposit");

        const matched = server.findMatchingRequirements(accepts(), payload);
        const verified = await server.verifyPayment(payload, matched!);
        expect(verified.isValid, JSON.stringify(verified)).toBe(true);

        const settled = await server.settlePayment(payload, matched!);
        expect(settled.success, JSON.stringify(settled)).toBe(true);

        channelId = (payload.payload as { voucher: { channelId: string } }).voucher.channelId;
        const rpc = createRpcClient(NETWORK, RPC_URL);
        const channel = await fetchMaybeChannel(rpc, channelId as never);
        expect(channel.exists).toBe(true);
        if (channel.exists) {
          expect(channel.data.deposit).toBe(BigInt(DEPOSIT));
          expect(channel.data.status).toBe(ChannelStatus.Open);
        }
        expect((await store.get(channelId))?.chargedCumulativeAmount).toBe(BigInt(PRICE));

        // The transport hands the response back to the client, which is what
        // commits its pending allocation; without it the client would keep
        // re-offering the same open.
        await clientScheme.schemeHooks.onPaymentResponse!({
          paymentPayload: payload,
          requirements: matched!,
          settleResponse: settled,
        } as never);
      },
    );

    it("serves a steady-state voucher with no transaction", { timeout: 120_000 }, async () => {
      const { client, clientScheme, server } = pipeline(lifecycleStore);
      await server.initialize();
      const required = await server.createPaymentRequiredResponse(accepts(), resource);
      // This client opened the channel in the previous stage, so it pays
      // with a voucher alone — no onchain transaction in the request path.
      const payload = await client.createPaymentPayload(required);
      expect((payload.payload as { type: string }).type).toBe("voucher");

      const matched = server.findMatchingRequirements(accepts(), payload);
      expect((await server.verifyPayment(payload, matched!)).isValid).toBe(true);
      const settled = await server.settlePayment(payload, matched!);
      expect(settled.success, JSON.stringify(settled)).toBe(true);
      expect(settled.transaction).toBe("");
      expect(settled.extra?.chargedAmount).toBe(PRICE);

      // Advancing the client is what the HTTP transport does with the
      // response; it also exercises the checks the client makes on it.
      await clientScheme.schemeHooks.onPaymentResponse!({
        paymentPayload: payload,
        requirements: matched!,
        settleResponse: settled,
      } as never);
      expect((await lifecycleStore.get(channelId))?.chargedCumulativeAmount).toBe(2_000n);
    });

    it(
      "resynchronizes a rediscovered client through a corrective 402",
      { timeout: 120_000 },
      async () => {
        // A client that kept no local record finds the channel it already
        // funded rather than opening a second one — but the base it adopts is
        // the onchain settled watermark, which lags what the server has
        // charged offchain.
        const { client, clientScheme, server } = pipeline(lifecycleStore, true);
        await server.initialize();
        const required = await server.createPaymentRequiredResponse(accepts(), resource);
        const payload = await client.createPaymentPayload(required);
        expect(
          (payload.payload as { voucher: { channelId: string } }).voucher.channelId,
          "the client reused the channel it had already opened",
        ).toBe(channelId);

        const matched = server.findMatchingRequirements(accepts(), payload);
        const verified = await server.verifyPayment(payload, matched!);
        expect(verified.isValid).toBe(false);
        expect(verified.invalidReason).toBe(
          "invalid_batch_settlement_svm_cumulative_amount_mismatch",
        );

        const corrective = await server.createPaymentRequiredResponse(
          accepts(),
          resource,
          verified.invalidReason,
          undefined,
          undefined,
          payload,
        );
        const accept = corrective.accepts.find(a => a.scheme === "batch-settlement");
        expect(accept?.extra?.channelState).toMatchObject({ chargedCumulativeAmount: "2000" });
        // The proof is the client's own signature at that amount.
        expect(accept?.extra?.voucherState).toMatchObject({ signedMaxClaimable: "2000" });

        const recovered = await clientScheme.schemeHooks.onPaymentResponse!({
          paymentPayload: payload,
          paymentRequired: corrective,
          requirements: matched!,
          settleResponse: { success: false },
        } as never);
        expect(recovered, "the client verified the proof and adopted the base").toMatchObject({
          recovered: true,
        });

        const retry = await client.createPaymentPayload(required);
        expect(
          (retry.payload as { voucher: { maxClaimableAmount: string } }).voucher.maxClaimableAmount,
        ).toBe("3000");
        const retryMatched = server.findMatchingRequirements(accepts(), retry);
        expect((await server.verifyPayment(retry, retryMatched!)).isValid).toBe(true);
        const settled = await server.settlePayment(retry, retryMatched!);
        expect(settled.success, JSON.stringify(settled)).toBe(true);
        expect((await lifecycleStore.get(channelId))?.chargedCumulativeAmount).toBe(3_000n);
      },
    );

    it("rebuilds a lost server record from chain", { timeout: 120_000 }, async () => {
      // The operator lost its store. The channel is open and funded onchain,
      // and the client is still holding a usable voucher base.
      const emptyStore = new MemoryChannelStore();
      const { client, server } = pipeline(emptyStore, true);
      await server.initialize();
      const required = await server.createPaymentRequiredResponse(accepts(), resource);
      const payload = await client.createPaymentPayload(required);
      const matched = server.findMatchingRequirements(accepts(), payload);

      const verified = await server.verifyPayment(payload, matched!);
      const rebuilt = await emptyStore.get(channelId);
      expect(rebuilt, "the record was rebuilt from confirmed onchain state").toBeDefined();
      expect(rebuilt?.deposit).toBe(BigInt(DEPOSIT));
      // Both sides rebuild from the same onchain watermark — the server from
      // the facilitator's snapshot, the client from its own scan — so they
      // agree on the base and the request is simply served. Before this, the
      // server refused every voucher on a funded, open channel.
      expect(rebuilt?.chargedCumulativeAmount).toBe(rebuilt?.settled);
      expect(verified.isValid, JSON.stringify(verified)).toBe(true);
      const settled = await server.settlePayment(payload, matched!);
      expect(settled.success, JSON.stringify(settled)).toBe(true);
    });

    it("redeems through the channel manager", { timeout: 180_000 }, async () => {
      // The worker an operator actually runs: it reads its own channel store,
      // claims what has vouchers, then distributes what those claims settled.
      const facilitator = new x402Facilitator().register(
        NETWORK,
        new BatchFacilitatorScheme(toFacilitatorSvmSigner(operator, { defaultRpcUrl: RPC_URL }), {
          rpcUrl: RPC_URL,
        }),
      );
      const before = await usdcBalance(receiver.address);
      const errors: unknown[] = [];
      const manager = new BatchChannelManager({
        onError: error => errors.push(error),
        requirements: accepts()[0]!,
        settle: (payload, requirements) => facilitator.settle(payload as never, requirements),
        store: lifecycleStore,
      });

      const redeemed = await manager.redeem();
      expect(errors, JSON.stringify(errors.map(String))).toEqual([]);
      expect(redeemed.claimed).toEqual([channelId]);
      expect(redeemed.distributed).toEqual([channelId]);

      const rpc = createRpcClient(NETWORK, RPC_URL);
      const settledOnchain = await fetchMaybeChannel(rpc, channelId as never);
      const charged = (await lifecycleStore.get(channelId))!.chargedCumulativeAmount;
      expect(settledOnchain.exists && settledOnchain.data.settlement.settled).toBe(charged);
      expect(settledOnchain.exists && settledOnchain.data.settlement.payoutWatermark).toBe(charged);
      // The receiver holds the money, and a second pass finds nothing to do.
      expect(await usdcBalance(receiver.address)).toBeGreaterThan(before);
      expect(await manager.redeem()).toEqual({ claimed: [], distributed: [] });
    });

    it("tops up a channel whose escrow is spent", { timeout: 120_000 }, async () => {
      // Its own channel, opened with exactly one request of escrow, so the
      // second request has to add more.
      const store = new MemoryChannelStore();
      const thrifty = new BatchClientScheme(payer, {
        depositAmount: PRICE,
        rpcUrl: RPC_URL,
        salt: "1",
      });
      const facilitator = new x402Facilitator().register(
        NETWORK,
        new BatchFacilitatorScheme(toFacilitatorSvmSigner(operator, { defaultRpcUrl: RPC_URL }), {
          rpcUrl: RPC_URL,
        }),
      );
      const server = new x402ResourceServer(new SvmFacilitatorClient(facilitator));
      server.register(NETWORK, new BatchServerScheme({ store, withdrawDelay: WITHDRAW_DELAY }));
      await server.initialize();
      const client = new x402Client().register(NETWORK, thrifty);

      const pay = async () => {
        const required = await server.createPaymentRequiredResponse(accepts(), resource);
        const payload = await client.createPaymentPayload(required);
        const matched = server.findMatchingRequirements(accepts(), payload);
        const verified = await server.verifyPayment(payload, matched!);
        expect(verified.isValid, JSON.stringify(verified)).toBe(true);
        const settled = await server.settlePayment(payload, matched!);
        expect(settled.success, JSON.stringify(settled)).toBe(true);
        await thrifty.schemeHooks.onPaymentResponse!({
          paymentPayload: payload,
          requirements: matched!,
          settleResponse: settled,
        } as never);
        return payload.payload as { type: string; voucher: { channelId: string } };
      };

      const opened = await pay();
      expect(opened.type).toBe("deposit");
      const rpc = createRpcClient(NETWORK, RPC_URL);
      const afterOpen = await fetchMaybeChannel(rpc, opened.voucher.channelId as never);
      expect(afterOpen.exists && afterOpen.data.deposit).toBe(BigInt(PRICE));

      // The escrow is spent, so this one carries a top-up transaction.
      const toppedUp = await pay();
      expect(toppedUp.type).toBe("deposit");
      expect(toppedUp.voucher.channelId).toBe(opened.voucher.channelId);
      const afterTopUp = await fetchMaybeChannel(rpc, opened.voucher.channelId as never);
      expect(afterTopUp.exists && afterTopUp.data.deposit).toBe(2n * BigInt(PRICE));
      expect((await store.get(opened.voucher.channelId))?.chargedCumulativeAmount).toBe(
        2n * BigInt(PRICE),
      );
    });

    it("starts the payer-forced close", { timeout: 120_000 }, async () => {
      const { clientScheme, server } = pipeline(lifecycleStore);
      await server.initialize();
      const required = await server.createPaymentRequiredResponse(accepts(), resource);
      const requirements = required.accepts.find(a => a.scheme === "batch-settlement")!;
      const refund = await clientScheme.createRefundPayload(2, requirements);
      const payload = { accepted: requirements, ...refund } as never;

      const matched = server.findMatchingRequirements(accepts(), payload);
      expect((await server.verifyPayment(payload, matched!)).isValid).toBe(true);
      const settled = await server.settlePayment(payload, matched!);
      expect(settled.success, JSON.stringify(settled)).toBe(true);

      const rpc = createRpcClient(NETWORK, RPC_URL);
      const closing = await fetchMaybeChannel(rpc, channelId as never);
      expect(closing.exists && closing.data.status).toBe(ChannelStatus.Closing);
      // A closed channel takes no further charge.
      expect((await lifecycleStore.get(channelId))?.status).toBe("closing");
    });
  });
});
