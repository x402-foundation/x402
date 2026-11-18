/**
 * Batch-settlement redemptions over transaction v1: the advertised
 * claim/settle capacity, the capacity check, the v1 build with a sized
 * compute budget, and the server's batch sizing from the copied capacity.
 */
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import {
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type KeyPairSigner,
} from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

import { BatchError } from "../../src/batch-settlement/errors";
import {
  MAX_CHANNELS_PER_SETTLE_TX,
  V1_MAX_CLAIM_CHANNELS,
  V1_MAX_SETTLE_CHANNELS,
} from "../../src/batch-settlement/facilitator/constants";
import {
  redemptionCapacity,
  redemptionPolicy,
  redemptionSubmitOptions,
  submitRedemptionTransaction,
} from "../../src/batch-settlement/facilitator/redemption";
import { BatchSvmScheme as BatchFacilitatorScheme } from "../../src/batch-settlement/facilitator/scheme";
import { BatchChannelManager } from "../../src/batch-settlement/server/channelManager";
import { MemoryChannelStore } from "../../src/batch-settlement/server/storage";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import {
  DEFAULT_FACILITATOR_TRANSACTION_VERSION,
  type FacilitatorTransactionVersion,
  facilitatorV1TransactionFits,
} from "../../src/payment-channels/facilitator";
import { BatchSvmRentCleanupManager } from "../../src/batch-settlement/facilitator/rentCleanupManager";
import {
  buildDistributeInstruction,
  buildSettleInstructions,
  type ServerInstruction,
} from "../../src/payment-channels/onchain";
import { InMemoryPaymentChannelStorage } from "../../src/payment-channels/storage";
import { toFacilitatorSvmSigner } from "../../src/signer";
import { readTransactionV1Config } from "../../src/transactionV1";

const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7));

async function claimInstructions(count: number): Promise<ServerInstruction[]> {
  const out: ServerInstruction[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(
      ...buildSettleInstructions({
        channelId: (await generateKeyPairSigner()).address,
        voucher: {
          authorizedSigner: (await generateKeyPairSigner()).address,
          cumulativeAmount: 123_456_789n,
          expiresAt: 0n,
          signatureBase58: SIGNATURE,
        },
      }),
    );
  }
  return out;
}

async function distributeInstructions(
  count: number,
  feePayer: KeyPairSigner,
  tokenProgram: string,
): Promise<ServerInstruction[]> {
  // Every channel in a batch settle pays the route's payTo.
  const payTo = (await generateKeyPairSigner()).address;
  const out: ServerInstruction[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(
      await buildDistributeInstruction({
        channelId: (await generateKeyPairSigner()).address,
        mint: USDC_DEVNET_ADDRESS,
        network: SOLANA_DEVNET_CAIP2,
        payee: feePayer.address,
        payer: (await generateKeyPairSigner()).address,
        rentPayer: feePayer.address,
        splits: [{ bps: 10_000, recipient: payTo }],
        tokenProgram,
      }),
    );
  }
  return out;
}

describe("redemption policy", () => {
  it("defaults to version 1 and refuses anything but 0 or 1", () => {
    expect(DEFAULT_FACILITATOR_TRANSACTION_VERSION).toBe(1);
    expect(redemptionPolicy(undefined).version).toBe(1);
    expect(redemptionPolicy(0).version).toBe(0);
    expect(() => redemptionPolicy(2 as FacilitatorTransactionVersion)).toThrow(
      /facilitatorTransactionVersion must be 0 or 1/,
    );
  });

  it("gives four channels on version 0 and the version-1 capacities otherwise", () => {
    expect(redemptionCapacity(0)).toEqual({ maxClaimChannels: 4, maxSettleChannels: 4 });
    expect(redemptionPolicy(undefined)).toEqual({
      maxClaimChannels: V1_MAX_CLAIM_CHANNELS,
      maxSettleChannels: V1_MAX_SETTLE_CHANNELS,
      version: 1,
    });
  });

  it("sizes the version-1 compute budget for the batch and caps it", () => {
    expect(redemptionSubmitOptions(0, 8)).toEqual({ facilitatorTransactionVersion: 0 });
    expect(redemptionSubmitOptions(1, 8)).toEqual({
      computeUnitLimit: 225_000,
      facilitatorTransactionVersion: 1,
    });
    expect(redemptionSubmitOptions(1, 100).computeUnitLimit).toBe(1_400_000);
  });
});

describe("version-1 redemption capacity", () => {
  it.each([TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS])(
    "fits the advertised claim and settle batches for %s",
    async tokenProgram => {
      const feePayer = await generateKeyPairSigner();
      const claims = await claimInstructions(V1_MAX_CLAIM_CHANNELS);
      expect(
        facilitatorV1TransactionFits(feePayer, claims, redemptionSubmitOptions(1, claims.length)),
      ).toBe(true);
      const distributes = await distributeInstructions(
        V1_MAX_SETTLE_CHANNELS,
        feePayer,
        tokenProgram,
      );
      expect(
        facilitatorV1TransactionFits(
          feePayer,
          distributes,
          redemptionSubmitOptions(1, distributes.length),
        ),
      ).toBe(true);
    },
  );

  it("does not fit one claim more than the advertised capacity", async () => {
    const feePayer = await generateKeyPairSigner();
    const claims = await claimInstructions(V1_MAX_CLAIM_CHANNELS + 1);
    expect(
      facilitatorV1TransactionFits(feePayer, claims, redemptionSubmitOptions(1, claims.length)),
    ).toBe(false);
  });
});

describe("submitRedemptionTransaction", () => {
  function submitSigner() {
    return {
      confirmTransaction: vi.fn().mockResolvedValue(undefined),
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 1n,
      }),
      sendTransaction: vi.fn().mockResolvedValue("sig"),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
    };
  }

  function compiledOf(wire: string) {
    const tx = getTransactionDecoder().decode(getBase64Codec().encode(wire));
    return getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  }

  it("builds a version-1 claim with a compute budget sized for the batch", async () => {
    const feePayer = await generateKeyPairSigner();
    const signer = submitSigner();
    const claims = await claimInstructions(V1_MAX_CLAIM_CHANNELS);
    await submitRedemptionTransaction(
      feePayer,
      signer as never,
      SOLANA_DEVNET_CAIP2,
      claims,
      1,
      async () => {},
    );
    const compiled = compiledOf(signer.sendTransaction.mock.calls[0]![0] as string);
    expect(compiled.version).toBe(1);
    expect(readTransactionV1Config(compiled)).toMatchObject({
      computeUnitLimit: 25_000 + 25_000 * claims.length,
      loadedAccountsDataSizeLimit: 4_194_304,
    });
  });

  it("keeps a version-0 redemption on version 0", async () => {
    const feePayer = await generateKeyPairSigner();
    const signer = submitSigner();
    await submitRedemptionTransaction(
      feePayer,
      signer as never,
      SOLANA_DEVNET_CAIP2,
      await claimInstructions(MAX_CHANNELS_PER_SETTLE_TX),
      0,
      async () => {},
    );
    expect(compiledOf(signer.sendTransaction.mock.calls[0]![0] as string).version).toBe(0);
  });

  it("fails a batch that does not fit before anything is sent", async () => {
    const feePayer = await generateKeyPairSigner();
    const signer = submitSigner();
    await expect(
      submitRedemptionTransaction(
        feePayer,
        signer as never,
        SOLANA_DEVNET_CAIP2,
        await claimInstructions(V1_MAX_CLAIM_CHANNELS + 1),
        1,
        async () => {},
      ),
    ).rejects.toThrow(new RegExp(`^${BatchError.PAYLOAD_TYPE}`));
    expect(signer.simulateTransaction).not.toHaveBeenCalled();
    expect(signer.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("batch facilitator capacity", () => {
  async function facilitator(facilitatorTransactionVersion?: FacilitatorTransactionVersion) {
    return new BatchFacilitatorScheme(toFacilitatorSvmSigner(await generateKeyPairSigner()), {
      channelStorage: new InMemoryPaymentChannelStorage(),
      facilitatorTransactionVersion,
    });
  }

  function cleanupVersion(manager: unknown): FacilitatorTransactionVersion {
    return (manager as { facilitatorTransactionVersion: FacilitatorTransactionVersion })
      .facilitatorTransactionVersion;
  }

  it("builds rent cleanup in the facilitator transaction version", async () => {
    const v1 = (await facilitator()).createRentCleanupManager(SOLANA_DEVNET_CAIP2);
    const v0 = (await facilitator(0)).createRentCleanupManager(SOLANA_DEVNET_CAIP2);
    expect(cleanupVersion(v1)).toBe(1);
    expect(cleanupVersion(v0)).toBe(0);
  });

  it("defaults a standalone rent cleanup manager to version 1", async () => {
    const config = {
      network: SOLANA_DEVNET_CAIP2,
      signer: toFacilitatorSvmSigner(await generateKeyPairSigner()),
      storage: new InMemoryPaymentChannelStorage(),
    } as const;
    expect(cleanupVersion(new BatchSvmRentCleanupManager(config))).toBe(1);
    expect(
      cleanupVersion(
        new BatchSvmRentCleanupManager({ ...config, facilitatorTransactionVersion: 0 }),
      ),
    ).toBe(0);
  });

  it.each([2, -1, "1", null])("rejects facilitatorTransactionVersion %j", async version => {
    const signer = toFacilitatorSvmSigner(await generateKeyPairSigner());
    expect(
      () =>
        new BatchFacilitatorScheme(signer, {
          channelStorage: new InMemoryPaymentChannelStorage(),
          facilitatorTransactionVersion: version as unknown as FacilitatorTransactionVersion,
        }),
    ).toThrow(/facilitatorTransactionVersion must be 0 or 1/);
    expect(
      () =>
        new BatchSvmRentCleanupManager({
          network: SOLANA_DEVNET_CAIP2,
          signer,
          storage: new InMemoryPaymentChannelStorage(),
          facilitatorTransactionVersion: version as unknown as FacilitatorTransactionVersion,
        }),
    ).toThrow(/facilitatorTransactionVersion must be 0 or 1/);
  });

  it("advertises four channels when redemptions are built as version 0", async () => {
    expect((await facilitator(0)).getExtra(SOLANA_DEVNET_CAIP2)).toMatchObject({
      maxClaimChannels: 4,
      maxSettleChannels: 4,
    });
  });

  it.each([
    [1, V1_MAX_CLAIM_CHANNELS + 1],
    [0, MAX_CHANNELS_PER_SETTLE_TX + 1],
  ] as const)(
    "rejects a version-%s claim request above its capacity (%s claims)",
    async (version, count) => {
      const scheme = await facilitator(version);
      await expect(
        scheme.settleClaims(
          {} as never,
          { claims: new Array(count).fill({}) } as never,
          {} as never,
        ),
      ).rejects.toThrow(new RegExp(`^${BatchError.PAYLOAD_TYPE}`));
    },
  );

  it.each([
    [1, V1_MAX_SETTLE_CHANNELS + 1],
    [0, MAX_CHANNELS_PER_SETTLE_TX + 1],
  ] as const)(
    "rejects a version-%s settle request above its capacity (%s channels)",
    async (version, count) => {
      const scheme = await facilitator(version);
      const channels = Array.from({ length: count }, (_, i) => ({ channelId: `c${i}` }));
      await expect(
        scheme.settleDistributions({} as never, { channels } as never, {} as never),
      ).rejects.toThrow(new RegExp(`^${BatchError.PAYLOAD_TYPE}`));
    },
  );
});

describe("server batch size", () => {
  async function batchSizes(
    extra: Record<string, unknown>,
    maxChannelsPerBatch?: number,
  ): Promise<{ claim: number; settle: number }> {
    const manager = new BatchChannelManager({
      maxChannelsPerBatch,
      receiverAuthorizer: await generateKeyPairSigner(),
      requirements: {
        amount: "1000",
        asset: USDC_DEVNET_ADDRESS,
        extra,
        maxTimeoutSeconds: 300,
        network: SOLANA_DEVNET_CAIP2,
        payTo: USDC_DEVNET_ADDRESS,
        scheme: "batch-settlement",
      } as PaymentRequirements,
      settle: vi.fn(),
      store: new MemoryChannelStore(),
    });
    const size = (manager as unknown as { batchSize(field: string): number }).batchSize.bind(
      manager,
    );
    return { claim: size("maxClaimChannels"), settle: size("maxSettleChannels") };
  }

  it("uses the capacity the facilitator advertised", async () => {
    expect(await batchSizes({ maxClaimChannels: 18, maxSettleChannels: 13 })).toEqual({
      claim: 18,
      settle: 13,
    });
  });

  it("clamps a misadvertised capacity to the protocol maximum", async () => {
    expect(await batchSizes({ maxClaimChannels: 50, maxSettleChannels: 50 })).toEqual({
      claim: V1_MAX_CLAIM_CHANNELS,
      settle: V1_MAX_SETTLE_CHANNELS,
    });
  });

  it("narrows it to maxChannelsPerBatch", async () => {
    expect(await batchSizes({ maxClaimChannels: 18, maxSettleChannels: 13 }, 8)).toEqual({
      claim: 8,
      settle: 8,
    });
  });

  it.each([[{}], [{ maxClaimChannels: "18", maxSettleChannels: 0 }], [{ maxClaimChannels: 2.5 }]])(
    "falls back to four when the capacity is absent or invalid (%j)",
    async extra => {
      expect(await batchSizes(extra)).toEqual({ claim: 4, settle: 4 });
    },
  );
});
