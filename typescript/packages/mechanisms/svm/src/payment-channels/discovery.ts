/**
 * Onchain discovery for payment-channels accounts, keyed by the facilitator
 * key that fronted their rent (spec §6). This is the recovery path for a
 * channel missing from offchain storage — deleted, never written, or lost —
 * not a substitute for the settle-time record, which also carries the
 * distribution recipient that Open/Sealed actions need.
 */

import { address, type Address, type Base58EncodedBytes, getBase64Encoder } from "@solana/kit";

import type { FacilitatorSvmSigner } from "../signer";
import type { Channel } from "./generated/accounts/channel";
import { AccountDiscriminator } from "./generated/types/accountDiscriminator";
import { getChannelDecoder } from "./generated/accounts/channel";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "./onchain";
import { findPaymentChannelPda } from "./open";

/** Fixed byte length of the channel account layout this scheme targets. */
export const CHANNEL_ACCOUNT_SIZE = 256n;

/** `Channel.rent_payer` byte offset; also the getProgramAccounts memcmp offset. */
export const CHANNEL_RENT_PAYER_OFFSET = 216n;

/**
 * Byte offset of `Channel.payer`, for discovering the channels a wallet funded.
 *
 * Derived from the account layout: the four preceding pubkeys sit after the
 * 88-byte header, and `rent_payer` at 216 is this offset plus four addresses.
 */
export const CHANNEL_PAYER_OFFSET = 88n;

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
/**
 * A `getProgramAccounts` scan, however the caller reaches the network.
 *
 * Lets a facilitator scan through its signer and a client through a plain RPC
 * client without either owning the validation that follows.
 */
export type ProgramAccountScan = (
  programId: string,
  filters: readonly unknown[],
) => Promise<readonly { pubkey: Address; account: { data: [string, string]; owner: Address } }[]>;

/** The scan filters that select channels by one 32-byte address field. */
export function channelAddressFilters(value: string, offset: bigint): readonly unknown[] {
  return [
    { dataSize: CHANNEL_ACCOUNT_SIZE },
    {
      memcmp: {
        bytes: value as Base58EncodedBytes,
        encoding: "base58",
        offset,
      },
    },
  ];
}

/**
 * Run a channel scan and keep only the rows the chain actually vouches for.
 *
 * Every row is decoded and its PDA rederived from its own fields, because a
 * `getProgramAccounts` filter result is never trusted on its own: an account
 * can carry any bytes at the filtered offset.
 */
export async function discoverChannels(
  scan: ProgramAccountScan,
  filters: readonly unknown[],
  programId?: string,
): Promise<DiscoveredChannel[]> {
  const program = address(programId ?? PAYMENT_CHANNELS_PROGRAM_ID);
  const rows = await scan(program.toString(), filters);
  const discovered: DiscoveredChannel[] = [];
  for (const row of rows) {
    const validated = await validateDiscoveredAccount(
      row.pubkey,
      row.account.owner,
      row.account.data[0],
      program,
    );
    if (validated) discovered.push(validated);
  }
  return discovered;
}

/**
 * Discover the channels a wallet opened and funded, for a client that has to
 * rebuild its own channel list.
 *
 * @param scan - How to reach `getProgramAccounts`
 * @param payer - The channel `payer` to scan for
 * @param programId - Payment-channels program override
 * @returns Every channel whose PDA rederives from its own fields
 */
export async function discoverChannelsByPayer(
  scan: ProgramAccountScan,
  payer: string,
  programId?: string,
): Promise<DiscoveredChannel[]> {
  return discoverChannels(scan, channelAddressFilters(payer, CHANNEL_PAYER_OFFSET), programId);
}

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
  const scan: ProgramAccountScan = (programAddress, filters) =>
    signer.getProgramAccounts!(network, programAddress, {
      commitment: "confirmed",
      encoding: "base64",
      filters,
    });
  return discoverChannels(
    scan,
    channelAddressFilters(rentPayer, CHANNEL_RENT_PAYER_OFFSET),
    programId,
  );
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

  const bytes = getBase64Encoder().encode(base64Data);
  if (bytes.byteLength < Number(CHANNEL_ACCOUNT_SIZE)) return undefined;

  let channel: Channel;
  try {
    channel = getChannelDecoder().decode(bytes);
  } catch {
    return undefined;
  }
  if (channel.discriminator !== AccountDiscriminator.Channel) return undefined;

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
