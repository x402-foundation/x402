/**
 * Receiver-authorizer binding carried by the canonical batch-settlement open.
 *
 * The client appends a Memo naming the challenged receiver authorizer. The
 * payer signature covers it, so a lost row is reconstructable in principle.
 */

import {
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isAddress,
} from "@solana/kit";

import { MEMO_PROGRAM_ADDRESS } from "../constants";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "../payment-channels/onchain";
import { OPEN_DISCRIMINATOR } from "../payment-channels/generated/instructions/open";

export const RECEIVER_BINDING_MEMO_PREFIX = "x402:batch-settlement:svm:rcvauth:v1:";

/** `channel` is the sixth account of the canonical payment-channels `open`. */
const OPEN_CHANNEL_ACCOUNT_INDEX = 5;

/**
 * Encode the binding memo text for a receiver authorizer.
 *
 * @param authorizer - Receiver-authorizer public key (base58)
 * @returns The Memo instruction text
 */
export function encodeReceiverBindingMemo(authorizer: string): string {
  return `${RECEIVER_BINDING_MEMO_PREFIX}${authorizer}`;
}

/**
 * Parse a binding memo back into its receiver-authorizer key.
 *
 * @param memo - Decoded Memo instruction text
 * @returns The key, or undefined when the memo is not a well-formed binding
 */
export function parseReceiverBindingMemo(memo: string): string | undefined {
  if (!memo.startsWith(RECEIVER_BINDING_MEMO_PREFIX)) return undefined;
  const authorizer = memo.slice(RECEIVER_BINDING_MEMO_PREFIX.length);
  return isAddress(authorizer) ? authorizer : undefined;
}

/**
 * Read the receiver authorizer a canonical open bound into `channelId`.
 *
 * The payer's signature covers the memo, and the open-slot and PDA rules
 * allow only one successful open per channel. Zero binding memos, or more
 * than one, is not a binding.
 *
 * @param wireTx - Base64 wire transaction
 * @param channelId - Channel PDA the open must create
 * @returns The bound key, or undefined when the transaction is not that open
 */
export function readReceiverBindingFromOpen(wireTx: string, channelId: string): string | undefined {
  let message: CompiledMessage;
  try {
    const decoded = getTransactionDecoder().decode(getBase64Codec().encode(wireTx));
    message = getCompiledTransactionMessageDecoder().decode(
      decoded.messageBytes,
    ) as unknown as CompiledMessage;
  } catch {
    return undefined;
  }
  if (message.addressTableLookups && message.addressTableLookups.length > 0) return undefined;

  const opens = message.instructions.filter(instruction => {
    const program = message.staticAccounts[instruction.programAddressIndex];
    return program === PAYMENT_CHANNELS_PROGRAM_ID && instruction.data?.[0] === OPEN_DISCRIMINATOR;
  });
  const open = opens.length === 1 ? opens[0] : undefined;
  if (!open) return undefined;
  const channelAccount =
    message.staticAccounts[open.accountIndices?.[OPEN_CHANNEL_ACCOUNT_INDEX] ?? -1];
  if (channelAccount !== channelId) return undefined;

  const bindings: string[] = [];
  for (const instruction of message.instructions) {
    if (message.staticAccounts[instruction.programAddressIndex] !== MEMO_PROGRAM_ADDRESS) continue;
    if (!instruction.data) continue;
    const parsed = parseReceiverBindingMemo(new TextDecoder().decode(instruction.data));
    if (parsed !== undefined) bindings.push(parsed);
  }
  return bindings.length === 1 ? bindings[0] : undefined;
}

type CompiledMessage = {
  addressTableLookups?: readonly unknown[];
  instructions: readonly {
    accountIndices?: readonly number[];
    data?: Uint8Array | undefined;
    programAddressIndex: number;
  }[];
  staticAccounts: readonly string[];
};
