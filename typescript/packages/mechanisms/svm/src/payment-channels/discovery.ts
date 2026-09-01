/**
 * Onchain discovery for payment-channels accounts, keyed by the facilitator
 * key that fronted their rent (spec §6). This is the recovery path for a
 * channel missing from offchain storage — deleted, never written, or lost —
 * not a substitute for the settle-time record, which also carries the
 * distribution recipient that Open/Sealed actions need.
 */

import { address, type Address, type Base58EncodedBytes } from "@solana/kit";

import type { FacilitatorSvmSigner } from "../signer";
import type { Channel } from "./generated/accounts/channel";
import { getChannelDecoder } from "./generated/accounts/channel";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "./onchain";
import { findPaymentChannelPda } from "./open";

/** Fixed byte length of the channel account layout this scheme targets. */
export const CHANNEL_ACCOUNT_SIZE = 256n;

/** `Channel.rent_payer` byte offset; also the getProgramAccounts memcmp offset. */
export const CHANNEL_RENT_PAYER_OFFSET = 216n;

/** A channel account found onchain and validated independent of offchain metadata. */
export interface DiscoveredChannel {
  channelId: string;
  channel: Channel;
}

/**
 * Find every payment-channels account a facilitator key fronted rent for.
 *
 * Filters onchain by `rent_payer` and account size, then independently
 * rederives each match's canonical PDA before accepting it — the RPC
 * provider's filter result is never trusted on its own. Owner is guaranteed
 * by `getProgramAccounts` itself, which only lists accounts owned by the
 * program passed to it.
 *
 * @param signer - Facilitator signer with {@link FacilitatorSvmSigner.getProgramAccounts}
 * @param network - CAIP-2 network identifier
 * @param rentPayer - Facilitator key to discover channels for (base58)
 * @param programId - Optional payment-channels program id override
 * @returns Validated discovered channels
 */
export async function discoverChannelsByRentPayer(
  signer: Pick<FacilitatorSvmSigner, "getProgramAccounts">,
  network: string,
  rentPayer: string,
  programId?: string,
): Promise<DiscoveredChannel[]> {
  if (typeof signer.getProgramAccounts !== "function") {
    throw new Error(
      "discoverChannelsByRentPayer requires getProgramAccounts on the signer. " +
        "Use toFacilitatorSvmSigner() which provides all required methods.",
    );
  }
  const program = address(programId ?? PAYMENT_CHANNELS_PROGRAM_ID);
  const results = await signer.getProgramAccounts(network, program.toString(), {
    commitment: "confirmed",
    encoding: "base64",
    filters: [
      { dataSize: CHANNEL_ACCOUNT_SIZE },
      {
        memcmp: {
          bytes: rentPayer as Base58EncodedBytes,
          encoding: "base58",
          offset: CHANNEL_RENT_PAYER_OFFSET,
        },
      },
    ],
  });

  const discovered: DiscoveredChannel[] = [];
  for (const result of results) {
    const validated = await validateDiscoveredAccount(
      result.pubkey,
      result.account.owner,
      result.account.data[0],
      program,
    );
    if (validated) discovered.push(validated);
  }
  return discovered;
}

/**
 * Reject anything a getProgramAccounts filter could theoretically be tricked
 * into returning: the wrong owner, a malformed account, or a PDA that does
 * not rederive to the address the account was found at. The RPC provider's
 * own account-owner filtering is never trusted on its own.
 *
 * @param pubkey - The address the account was found at
 * @param owner - The account owner the RPC provider reported
 * @param base64Data - Base64-encoded account data
 * @param expectedProgram - The payment-channels program id accounts must be owned by
 * @returns The validated discovered channel, or undefined when invalid
 */
async function validateDiscoveredAccount(
  pubkey: Address,
  owner: Address,
  base64Data: string,
  expectedProgram: Address,
): Promise<DiscoveredChannel | undefined> {
  if (owner !== expectedProgram) return undefined;

  const bytes = Buffer.from(base64Data, "base64");
  if (bytes.byteLength < Number(CHANNEL_ACCOUNT_SIZE)) return undefined;

  let channel: Channel;
  try {
    channel = getChannelDecoder().decode(bytes);
  } catch {
    return undefined;
  }
  if (channel.discriminator !== 1) return undefined;

  const derived = await findPaymentChannelPda({
    authorizedSigner: channel.authorizedSigner,
    mint: channel.mint,
    openSlot: channel.openSlot,
    payee: channel.payee,
    payer: channel.payer,
    salt: channel.salt,
  });
  if (derived !== pubkey) return undefined;

  return { channelId: pubkey, channel };
}
