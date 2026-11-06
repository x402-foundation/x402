import { generateKeyPairSigner, getBase64Decoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";

import {
  CHANNEL_PAYER_OFFSET,
  discoverChannelsByPayer,
  type ProgramAccountScan,
} from "../../src/payment-channels/discovery";
import { getChannelEncoder } from "../../src/payment-channels/generated/accounts/channel";
import { AccountDiscriminator } from "../../src/payment-channels/generated/types/accountDiscriminator";
import { ChannelStatus } from "../../src/payment-channels/generated/types/channelStatus";
import { findPaymentChannelPda } from "../../src/payment-channels/open";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "../../src/payment-channels/onchain";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";

describe("payment-channel discovery by payer", () => {
  it("keeps only rows whose PDA rederives from their own fields", async () => {
    const payer = await generateKeyPairSigner();
    const payee = await generateKeyPairSigner();
    const salt = 0n;
    const openSlot = 500n;
    const channelId = await findPaymentChannelPda({
      authorizedSigner: payer.address,
      mint: USDC_DEVNET_ADDRESS,
      openSlot,
      payee: payee.address,
      payer: payer.address,
      salt,
    });
    const encode = (overrides: Record<string, unknown> = {}) =>
      getBase64Decoder().decode(
        getChannelEncoder().encode({
          authorizedSigner: payer.address as Address,
          bump: 0,
          closureStartedAt: 0n,
          deposit: 10_000n,
          discriminator: AccountDiscriminator.Channel,
          distributionHash: new Array(32).fill(0),
          gracePeriod: 900,
          mint: USDC_DEVNET_ADDRESS as Address,
          openSlot,
          payee: payee.address as Address,
          payer: payer.address as Address,
          payerWithdrawnAt: 0n,
          rentPayer: payee.address as Address,
          salt,
          settlement: { payoutWatermark: 0n, settled: 2_000n },
          status: ChannelStatus.Open,
          version: 1,
          ...overrides,
        } as never),
      );

    const scan =
      (rows: { pubkey: string; data: string; owner: string }[]): ProgramAccountScan =>
      async (_programId, filters) => {
        // The filter must select on the payer offset, or the scan would return
        // every channel the program owns.
        expect(filters).toMatchObject([
          {},
          { memcmp: { bytes: payer.address, offset: CHANNEL_PAYER_OFFSET } },
        ]);
        return rows.map(row => ({
          account: { data: [row.data, "base64"] as [string, string], owner: row.owner as Address },
          pubkey: row.pubkey as Address,
        }));
      };

    // A genuine channel account.
    await expect(
      discoverChannelsByPayer(
        scan([{ data: encode(), owner: PAYMENT_CHANNELS_PROGRAM_ID, pubkey: channelId }]),
        payer.address,
      ),
    ).resolves.toMatchObject([{ channelId, channel: { deposit: 10_000n } }]);

    // Same bytes at another address: the PDA no longer rederives, so a crafted
    // account cannot pass itself off as a channel.
    expect(
      await discoverChannelsByPayer(
        scan([{ data: encode(), owner: PAYMENT_CHANNELS_PROGRAM_ID, pubkey: payee.address }]),
        payer.address,
      ),
    ).toEqual([]);

    // Owned by a different program.
    expect(
      await discoverChannelsByPayer(
        scan([{ data: encode(), owner: payee.address, pubkey: channelId }]),
        payer.address,
      ),
    ).toEqual([]);

    // Right address, but the seeds inside disagree with it.
    expect(
      await discoverChannelsByPayer(
        scan([
          {
            data: encode({ openSlot: 501n }),
            owner: PAYMENT_CHANNELS_PROGRAM_ID,
            pubkey: channelId,
          },
        ]),
        payer.address,
      ),
    ).toEqual([]);
  });
});
