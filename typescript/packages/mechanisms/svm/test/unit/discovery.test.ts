import { generateKeyPairSigner } from "@solana/kit";
import type { Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import { discoverChannelsByRentPayer } from "../../src/payment-channels/discovery";
import { getChannelEncoder } from "../../src/payment-channels/generated/accounts/channel";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "../../src/payment-channels/onchain";
import { findPaymentChannelPda } from "../../src/payment-channels/open";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import type { FacilitatorSvmSigner } from "../../src/signer";

/**
 * Builds a channel account whose payer/payee/mint/authorizedSigner/salt/
 * openSlot rederive to its own PDA, as a genuine onchain channel must, and
 * returns it alongside the base64-encoded account bytes a stub RPC serves.
 *
 * @param rentPayer - `rent_payer` field to embed in the account
 * @returns The derived channel PDA and its base64-encoded account bytes
 */
async function validDiscoveryChannel(rentPayer: string): Promise<{ pda: string; data: string }> {
  const payer = await generateKeyPairSigner();
  const payee = await generateKeyPairSigner();
  const authorizedSigner = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  const salt = 7n;
  const openSlot = 341_000_000n;

  const pda = await findPaymentChannelPda({
    authorizedSigner: authorizedSigner.address,
    mint: mint.address,
    openSlot,
    payee: payee.address,
    payer: payer.address,
    salt,
  });

  const bytes = getChannelEncoder().encode({
    authorizedSigner: authorizedSigner.address,
    bump: 255,
    closureStartedAt: 0,
    deposit: 1_000_000,
    discriminator: 1,
    distributionHash: new Array(32).fill(0),
    gracePeriod: 3_600,
    mint: mint.address,
    openSlot,
    payee: payee.address,
    payer: payer.address,
    payerWithdrawnAt: 0,
    rentPayer: rentPayer as Address,
    salt,
    settlement: { payoutWatermark: 0, settled: 0 },
    status: 3, // Distributed
    version: 1,
  });

  return { pda, data: Buffer.from(bytes).toString("base64") };
}

/**
 * A stub signer exposing only the `getProgramAccounts` shape discovery uses.
 *
 * @param rows - Canned getProgramAccounts rows to serve
 * @returns A signer-compatible stub
 */
function stubSigner(
  rows: { pubkey: string; owner: string; data: string }[],
): Pick<FacilitatorSvmSigner, "getProgramAccounts"> {
  return {
    getProgramAccounts: vi.fn().mockResolvedValue(
      rows.map(row => ({
        account: { data: [row.data, "base64"] as [string, string], owner: row.owner as Address },
        pubkey: row.pubkey as Address,
      })),
    ),
  } as unknown as Pick<FacilitatorSvmSigner, "getProgramAccounts">;
}

describe("discoverChannelsByRentPayer", () => {
  it("accepts a validated account", async () => {
    const rentPayer = (await generateKeyPairSigner()).address;
    const { pda, data } = await validDiscoveryChannel(rentPayer);
    const signer = stubSigner([{ data, owner: PAYMENT_CHANNELS_PROGRAM_ID, pubkey: pda }]);

    const discovered = await discoverChannelsByRentPayer(signer, SOLANA_DEVNET_CAIP2, rentPayer);

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.channelId).toBe(pda);
    expect(discovered[0]?.channel.rentPayer).toBe(rentPayer);
  });

  it("rejects an account owned by the wrong program", async () => {
    const rentPayer = (await generateKeyPairSigner()).address;
    const { pda, data } = await validDiscoveryChannel(rentPayer);
    const wrongOwner = (await generateKeyPairSigner()).address;
    const signer = stubSigner([{ data, owner: wrongOwner, pubkey: pda }]);

    const discovered = await discoverChannelsByRentPayer(signer, SOLANA_DEVNET_CAIP2, rentPayer);

    expect(discovered).toHaveLength(0);
  });

  it("rejects an account whose address does not rederive to its own PDA", async () => {
    const rentPayer = (await generateKeyPairSigner()).address;
    const { data } = await validDiscoveryChannel(rentPayer);
    // The RPC provider claims this address matched, but the account's own
    // fields derive to a different PDA — never trust the filter alone.
    const wrongPubkey = (await generateKeyPairSigner()).address;
    const signer = stubSigner([{ data, owner: PAYMENT_CHANNELS_PROGRAM_ID, pubkey: wrongPubkey }]);

    const discovered = await discoverChannelsByRentPayer(signer, SOLANA_DEVNET_CAIP2, rentPayer);

    expect(discovered).toHaveLength(0);
  });

  it("rejects a malformed account", async () => {
    const rentPayer = (await generateKeyPairSigner()).address;
    const pda = (await generateKeyPairSigner()).address;
    const signer = stubSigner([
      {
        data: Buffer.from([0x01, 0x02]).toString("base64"),
        owner: PAYMENT_CHANNELS_PROGRAM_ID,
        pubkey: pda,
      },
    ]);

    const discovered = await discoverChannelsByRentPayer(signer, SOLANA_DEVNET_CAIP2, rentPayer);

    expect(discovered).toHaveLength(0);
  });

  it("filters onchain by account size and rent_payer offset", async () => {
    const rentPayer = (await generateKeyPairSigner()).address;
    const signer = stubSigner([]);

    await discoverChannelsByRentPayer(signer, SOLANA_DEVNET_CAIP2, rentPayer);

    expect(signer.getProgramAccounts).toHaveBeenCalledWith(
      SOLANA_DEVNET_CAIP2,
      PAYMENT_CHANNELS_PROGRAM_ID,
      expect.objectContaining({
        filters: [
          expect.objectContaining({ dataSize: 256n }),
          expect.objectContaining({
            memcmp: expect.objectContaining({ bytes: rentPayer, offset: 216n }),
          }),
        ],
      }),
    );
  });
});
