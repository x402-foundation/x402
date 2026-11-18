/**
 * The SPL token account layout shared by Token and Token-2022, read as the
 * payment-channels program reads a payout destination.
 */

import { getAddressDecoder } from "@solana/kit";

/** Base length of an SPL token account; Token-2022 appends its extensions after it. */
export const TOKEN_ACCOUNT_LEN = 165;

/** `AccountState::Initialized`, at offset 108. */
const TOKEN_ACCOUNT_INITIALIZED = 1;

/** `AccountState::Frozen`: the account cannot receive or send. */
const TOKEN_ACCOUNT_FROZEN = 2;

/** `AccountType::Account`, the byte a Token-2022 account carries at offset 165. */
const TOKEN_ACCOUNT_TYPE = 2;

/**
 * `ExtensionType::ImmutableOwner`: the only account extension a settlement
 * destination may carry. It fixes the owner and nothing else, and every
 * associated token account has it.
 */
const EXTENSION_IMMUTABLE_OWNER = 7;

/** The fields of a token account a settlement check reads. */
export interface DecodedTokenAccount {
  mint: string;
  owner: string;
  amount: bigint;
  state: number;
  /** The first extension outside the allowlist, if the account has one. */
  unsupportedExtension?: number | undefined;
}

/**
 * Decode a token account, or undefined when the data is too short to be one
 * (which is what an uninitialized or non-token account looks like).
 *
 * @param data - Raw account data
 * @returns The decoded fields, or undefined
 */
export function decodeTokenAccount(data: Uint8Array): DecodedTokenAccount | undefined {
  if (data.length < TOKEN_ACCOUNT_LEN) return undefined;
  const addresses = getAddressDecoder();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: addresses.decode(data.subarray(0, 32)),
    owner: addresses.decode(data.subarray(32, 64)),
    amount: view.getBigUint64(64, true),
    state: data[108]!,
    unsupportedExtension: unsupportedAccountExtension(data),
  };
}

/**
 * The first account extension outside the allowlist. A malformed or truncated
 * TLV list is reported as unsupported rather than skipped: the caller decides
 * from it whether to accept an escrow.
 *
 * @param data - Raw account data of at least {@link TOKEN_ACCOUNT_LEN} bytes
 * @returns The extension type, or undefined when every extension is allowed
 */
function unsupportedAccountExtension(data: Uint8Array): number | undefined {
  if (data.length === TOKEN_ACCOUNT_LEN) return undefined;
  if (data[TOKEN_ACCOUNT_LEN] !== TOKEN_ACCOUNT_TYPE) return data[TOKEN_ACCOUNT_LEN];
  let cursor = TOKEN_ACCOUNT_LEN + 1;
  while (cursor < data.length) {
    // A run of zero padding ends the list.
    if (data.subarray(cursor).every(byte => byte === 0)) return undefined;
    if (cursor + 4 > data.length) return 0xffff;
    const extension = data[cursor]! | (data[cursor + 1]! << 8);
    const length = data[cursor + 2]! | (data[cursor + 3]! << 8);
    if (extension !== EXTENSION_IMMUTABLE_OWNER) return extension;
    const next = cursor + 4 + length;
    if (next > data.length) return 0xffff;
    cursor = next;
  }
  return undefined;
}

/**
 * Why the token account at `owner`'s associated token address cannot take a
 * settlement payout, or undefined when it can. It must be an initialized,
 * unfrozen account of the declared token program holding `mint` for `owner`,
 * with no extension outside the allowlist: the program forfeits a payout to an
 * unusable account, and the escrow is locked before the request is served.
 *
 * @param account - The account's owning program and raw data
 * @param account.programOwner - Program that owns the account
 * @param account.data - Raw account data
 * @param owner - Wallet the account must belong to
 * @param mint - Mint the account must hold
 * @param tokenProgram - Token program the account must belong to
 * @returns A description of the problem, or undefined
 */
export function unusableSettlementAccount(
  account: { programOwner: string; data: Uint8Array },
  owner: string,
  mint: string,
  tokenProgram: string,
): string | undefined {
  if (account.programOwner !== tokenProgram) {
    return `is not owned by ${tokenProgram}`;
  }
  const decoded = decodeTokenAccount(account.data);
  if (!decoded) return "is not an initialized token account";
  if (decoded.mint !== mint) return `holds mint ${decoded.mint} rather than ${mint}`;
  if (decoded.owner !== owner) return `is owned by ${decoded.owner} rather than ${owner}`;
  if (decoded.state === TOKEN_ACCOUNT_FROZEN) return "is frozen";
  if (decoded.unsupportedExtension !== undefined) {
    return `carries token account extension ${decoded.unsupportedExtension}`;
  }
  if (decoded.state !== TOKEN_ACCOUNT_INITIALIZED) {
    return `is in account state ${decoded.state}`;
  }
  return undefined;
}
