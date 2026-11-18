/**
 * Batch-settlement: charge baseline after the server loses its local channel record.
 *
 * After a channel's local server record is lost (e.g. a full cooperative refund), the server must
 * take the charge baseline from the on-chain `totalClaimed`, so every paid request advances the
 * voucher's cumulative ceiling by at least the route price.
 *
 * Runs against a local anvil fork (never live Base Sepolia; it spends real USDC):
 *
 *   anvil --fork-url https://sepolia.base.org --port 8548 --silent &
 *   EVM_RPC_URL=http://127.0.0.1:8548 pnpm test:integration -- test/integrations/batch-settlement-charge-baseline.test.ts
 *
 * Required env: CLIENT_PRIVATE_KEY, FACILITATOR_PRIVATE_KEY, EVM_RPC_URL (http://127.*).
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
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
import { BatchSettlementEvmScheme as BatchSettlementEvmClient } from "../../src/batch-settlement/client/scheme";
import { InMemoryClientChannelStorage } from "../../src/batch-settlement/client/storage";
import { createBatchSettlementEIP3009DepositPayload } from "../../src/batch-settlement/client/eip3009";
import { signVoucher } from "../../src/batch-settlement/client/voucher";
import { BatchSettlementEvmScheme as BatchSettlementEvmServer } from "../../src/batch-settlement/server/scheme";
import { BatchSettlementEvmScheme as BatchSettlementEvmFacilitator } from "../../src/batch-settlement/facilitator/scheme";
import type { AuthorizerSigner } from "../../src/batch-settlement/types";
import { computeChannelId } from "../../src/batch-settlement/utils";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, createPublicClient, http, getAddress } from "viem";
import { baseSepolia } from "viem/chains";
import { batchSettlementABI } from "../../src/batch-settlement/abi";
import { BATCH_SETTLEMENT_ADDRESS } from "../../src/batch-settlement/constants";

const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY as `0x${string}` | undefined;
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY as `0x${string}` | undefined;
const RPC_URL = process.env.EVM_RPC_URL ?? "";

const RUNNABLE = Boolean(
  CLIENT_PRIVATE_KEY && FACILITATOR_PRIVATE_KEY && RPC_URL.startsWith("http://127."),
);
const describeOnChain = RUNNABLE ? describe : describe.skip;

if (!RUNNABLE) {
  console.warn(
    "[batch-settlement-charge-baseline.test.ts] Skipping: needs CLIENT_PRIVATE_KEY, FACILITATOR_PRIVATE_KEY and EVM_RPC_URL pointing at a local anvil fork.",
  );
}

const NETWORK: Network = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PRICE = 50_000n; // route price P in USDC atoms
const INITIAL_DEPOSIT = 3n * PRICE;

/** Wraps an x402Facilitator as a FacilitatorClient. */
class LocalFacilitatorClient implements FacilitatorClient {
  /** @param facilitator - Facilitator to wrap. */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * @param p - Payload.
   * @param r - Requirements.
   * @returns Verify response.
   */
  verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    return this.facilitator.verify(p, r);
  }

  /**
   * @param p - Payload.
   * @param r - Requirements.
   * @returns Settle response.
   */
  settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    return this.facilitator.settle(p, r);
  }

  /** @returns Supported kinds. */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported());
  }
}

/** Fresh channel (random salt) wired to the real facilitator and contract. */
class Env {
  readonly clientAccount = privateKeyToAccount(CLIENT_PRIVATE_KEY!);
  readonly facilitatorAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY!);
  readonly publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
  readonly clientSigner = toClientEvmSigner(this.clientAccount, this.publicClient);
  readonly serverScheme: BatchSettlementEvmServer;
  readonly server: x402ResourceServer;
  readonly facilitatorClient: FacilitatorClient;
  readonly requirements: PaymentRequirements;
  readonly config: ReturnType<BatchSettlementEvmClient["buildChannelConfig"]>;
  readonly channelId: `0x${string}`;

  /** Builds the pipeline. */
  constructor() {
    const walletClient = createWalletClient({
      account: this.facilitatorAccount,
      chain: baseSepolia,
      transport: http(RPC_URL),
    });
    const facilitatorSigner = toFacilitatorEvmSigner({
      address: this.facilitatorAccount.address,
      readContract: args =>
        this.publicClient.readContract({ ...args, args: args.args || [] } as never),
      verifyTypedData: args => this.publicClient.verifyTypedData(args as never),
      writeContract: args =>
        walletClient.writeContract({ ...args, args: args.args || [] } as never),
      sendTransaction: args => walletClient.sendTransaction(args),
      waitForTransactionReceipt: args => this.publicClient.waitForTransactionReceipt(args),
      getCode: args => this.publicClient.getCode(args),
    });
    const authorizerSigner: AuthorizerSigner = {
      address: this.facilitatorAccount.address,
      signTypedData: msg =>
        this.facilitatorAccount.signTypedData({
          domain: msg.domain,
          types: msg.types,
          primaryType: msg.primaryType,
          message: msg.message,
        } as Parameters<typeof this.facilitatorAccount.signTypedData>[0]),
    };

    const facilitator = new x402Facilitator().register(
      NETWORK,
      new BatchSettlementEvmFacilitator(facilitatorSigner, authorizerSigner),
    );
    this.facilitatorClient = new LocalFacilitatorClient(facilitator);

    const clientScheme = new BatchSettlementEvmClient(this.clientSigner, {
      salt: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
      storage: new InMemoryClientChannelStorage(),
    });

    this.serverScheme = new BatchSettlementEvmServer(this.facilitatorAccount.address, {
      receiverAuthorizerSigner: authorizerSigner,
    });
    this.server = new x402ResourceServer(this.facilitatorClient);
    this.server.register(NETWORK, this.serverScheme);

    this.requirements = {
      scheme: "batch-settlement",
      network: NETWORK,
      asset: USDC,
      amount: PRICE.toString(),
      payTo: this.facilitatorAccount.address,
      maxTimeoutSeconds: 3600,
      extra: {
        name: "USDC",
        version: "2",
        assetTransferMethod: "eip3009",
        receiverAuthorizer: authorizerSigner.address,
      },
    };
    this.config = clientScheme.buildChannelConfig(this.requirements);
    this.channelId = computeChannelId(this.config, NETWORK);
  }

  /** @returns On-chain `[balance, totalClaimed]`. */
  async onchain(): Promise<[bigint, bigint]> {
    const [balance, totalClaimed] = (await this.publicClient.readContract({
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "channels",
      args: [this.channelId],
    })) as [bigint, bigint];
    return [balance, totalClaimed];
  }

  /** @returns Local server-side charged amount, or undefined when no record exists. */
  async localCharged(): Promise<string | undefined> {
    return (await this.serverScheme.getStorage().get(this.channelId))?.chargedCumulativeAmount;
  }

  /**
   * @param deposit - Deposit amount in atoms.
   * @param maxClaimable - Voucher cumulative ceiling.
   * @returns Signed deposit payload.
   */
  async depositPayload(deposit: bigint, maxClaimable: bigint): Promise<PaymentPayload> {
    const res = await createBatchSettlementEIP3009DepositPayload(
      this.clientSigner,
      2,
      this.requirements,
      this.config,
      deposit.toString(),
      maxClaimable.toString(),
    );
    return { x402Version: 2, payload: res.payload, accepted: this.requirements };
  }

  /**
   * @param maxClaimable - Voucher cumulative ceiling.
   * @returns Signed voucher payload.
   */
  async voucherPayload(maxClaimable: bigint): Promise<PaymentPayload> {
    const voucher = await signVoucher(
      this.clientSigner,
      this.channelId,
      maxClaimable.toString(),
      NETWORK,
    );
    return {
      x402Version: 2,
      payload: { type: "voucher", channelConfig: this.config, voucher },
      accepted: this.requirements,
    };
  }

  /**
   * Verify (gate before the protected handler) then settle, like the HTTP middleware.
   *
   * @param payload - Payment payload.
   * @returns Whether the request was accepted and settled.
   */
  async pay(
    payload: PaymentPayload,
  ): Promise<{ valid: boolean; settled: boolean; reason?: string }> {
    const v = await this.server.verifyPayment(payload, this.requirements);
    if (!v.isValid) return { valid: false, settled: false, reason: v.invalidReason };
    const s = await this.server.settlePayment(payload, this.requirements);
    return { valid: true, settled: s.success, reason: s.errorReason };
  }

  /** Full cooperative refund through the server channel manager; deletes the local record. */
  async fullRefund(): Promise<void> {
    const manager = this.serverScheme.createChannelManager(this.facilitatorClient, NETWORK);
    const results = await manager.refund([this.channelId]);
    expect(results.length, `refund failed: ${JSON.stringify(results)}`).toBe(1);
    expect(await this.localCharged(), "full refund must delete the local channel record").toBe(
      undefined,
    );
  }

  /** @returns On-chain totalClaimed after legit usage then a full refund (T > 0, no local record). */
  async establishClaimedState(): Promise<bigint> {
    await this.server.initialize();
    const r = await this.pay(await this.depositPayload(INITIAL_DEPOSIT, PRICE));
    expect(r, `legit first payment failed: ${JSON.stringify(r)}`).toMatchObject({
      valid: true,
      settled: true,
    });
    await this.fullRefund();
    const [balance, totalClaimed] = await this.onchain();
    expect([balance, totalClaimed]).toEqual([PRICE, PRICE]);
    return totalClaimed;
  }
}

describeOnChain("Batch-Settlement charge baseline after local record loss", () => {
  it(
    "accepts a voucher advancing by exactly the price after record loss",
    { timeout: 120000 },
    async () => {
      const env = new Env();
      const t = await env.establishClaimedState();
      const r = await env.pay(await env.depositPayload(2n * PRICE, t + PRICE));
      expect(r, `voucher advancing by price was rejected: ${JSON.stringify(r)}`).toMatchObject({
        valid: true,
        settled: true,
      });
    },
  );

  it(
    "rejects a voucher advancing by less than the price after record loss",
    { timeout: 120000 },
    async () => {
      const env = new Env();
      const t = await env.establishClaimedState();
      const r = await env.pay(await env.depositPayload(2n, t + 1n));
      expect(
        r.valid,
        `voucher advancing by 1 < price ${PRICE} was accepted (local charged=${await env.localCharged()}, onchain T=${t})`,
      ).toBe(false);
    },
  );

  it(
    "advances the collectible entitlement by the full price on every record-loss cycle",
    { timeout: 300000 },
    async () => {
      const env = new Env();
      let t = await env.establishClaimedState();
      const gains: bigint[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        // Try a voucher advancing by less than the price; a correct server rejects it, in which
        // case the honest increment must be accepted and advance the entitlement by the price.
        let r = await env.pay(await env.depositPayload(2n, t + 1n));
        if (!(r.valid && r.settled)) {
          r = await env.pay(await env.depositPayload(2n * PRICE, t + PRICE));
          expect(r, `honest increment rejected: ${JSON.stringify(r)}`).toMatchObject({
            valid: true,
            settled: true,
          });
        }
        await env.fullRefund();
        const [, newT] = await env.onchain();
        gains.push(newT - t);
        t = newT;
      }
      expect(
        gains.every(g => g === PRICE),
        `entitlement gained per delivered call was [${gains}] atoms vs price ${PRICE}`,
      ).toBe(true);
    },
  );

  it(
    "rejects a second shortfall voucher without a fresh record loss",
    { timeout: 120000 },
    async () => {
      const env = new Env();
      const t = await env.establishClaimedState();
      const first = await env.pay(await env.depositPayload(2n, t + 1n));
      if (!(first.valid && first.settled)) return; // shortfall already rejected at the first step
      const charged = BigInt((await env.localCharged())!);
      const second = await env.pay(await env.voucherPayload(charged + 1n));
      expect(second.valid, "a second shortfall voucher was accepted without any state loss").toBe(
        false,
      );
    },
  );
});
