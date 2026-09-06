/** Client construction and facilitator verification for payer-forced channel close. */

import {
  AccountRole,
  appendTransactionMessageInstructions,
  type Address,
  address,
  type Blockhash,
  createTransactionMessage,
  getBase58Encoder,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isSignerRole,
  isWritableRole,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";

import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  LIGHTHOUSE_PROGRAM_ADDRESS,
  MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MAX_MEMO_BYTES,
  MEMO_PROGRAM_ADDRESS,
} from "../constants";
import {
  getRequestCloseInstruction,
  REQUEST_CLOSE_DISCRIMINATOR,
} from "./generated/instructions/requestClose";
import { OPEN_MAX_COMPUTE_UNIT_LIMIT } from "./open";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "./onchain";
import { verifyEd25519Signature } from "./voucher";

const MAX_LIGHTHOUSE_INSTRUCTIONS = 3;

type CompiledMessage = {
  addressTableLookups?: readonly unknown[];
  header: {
    numReadonlyNonSignerAccounts: number;
    numReadonlySignerAccounts: number;
    numSignerAccounts: number;
  };
  instructions: readonly {
    accountIndices?: readonly number[];
    data?: Uint8Array | undefined;
    programAddressIndex: number;
  }[];
  staticAccounts: readonly string[];
};

export interface BuildRequestCloseArgs {
  payer: TransactionSigner;
  feePayer: string;
  channelId: string;
  blockhash: { blockhash: string; lastValidBlockHeight: bigint };
  memo?: string | undefined;
  programId?: string | undefined;
}

/** Build a payer-signed `request_close` transaction with an empty sponsor signature slot. */
export async function buildRequestCloseTransaction(args: BuildRequestCloseArgs): Promise<string> {
  const programAddress = address(args.programId ?? PAYMENT_CHANNELS_PROGRAM_ID);
  const requestClose = getRequestCloseInstruction(
    { channel: address(args.channelId), payer: args.payer },
    { programAddress },
  );
  const memoData = requestMemo(args.memo);
  const memo = {
    programAddress: MEMO_PROGRAM_ADDRESS as Address,
    accounts: [] as const,
    data: memoData,
  };
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    value => setTransactionMessageFeePayer(address(args.feePayer), value),
    value =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: args.blockhash.blockhash as Blockhash,
          lastValidBlockHeight: args.blockhash.lastValidBlockHeight,
        },
        value,
      ),
    value => appendTransactionMessageInstructions([requestClose, memo], value),
  );
  const signed = await partiallySignTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(signed);
}

export interface VerifyRequestCloseExpected {
  payer: string;
  feePayer: string;
  channelId: string;
  memo?: string | undefined;
  programId?: string | undefined;
  maxComputeUnits?: number | undefined;
  maxPriorityFeeMicroLamports?: number | undefined;
}

/**
 * Verify the complete sponsor-bound transaction envelope for `request_close`.
 * The sponsor may authorize only the fee for one canonical close instruction.
 */
export async function verifyRequestCloseTransaction(
  transactionBase64: string,
  expected: VerifyRequestCloseExpected,
): Promise<void> {
  if (expected.payer === expected.feePayer) {
    throw new Error("verifyRequestCloseTransaction: payer must differ from feePayer");
  }
  const decoded = getTransactionDecoder().decode(getBase64Codec().encode(transactionBase64));
  const message = getCompiledTransactionMessageDecoder().decode(
    decoded.messageBytes,
  ) as unknown as CompiledMessage;
  if (message.addressTableLookups && message.addressTableLookups.length > 0) {
    throw new Error("verifyRequestCloseTransaction: address lookup tables are not permitted");
  }

  const signers = message.staticAccounts.slice(0, message.header.numSignerAccounts);
  const expectedSigners = new Set([expected.feePayer, expected.payer]);
  if (
    signers.length !== expectedSigners.size ||
    signers.some(value => !expectedSigners.has(value))
  ) {
    throw new Error("verifyRequestCloseTransaction: required signers must be payer and feePayer");
  }
  if (message.staticAccounts[0] !== expected.feePayer) {
    throw new Error("verifyRequestCloseTransaction: transaction fee payer mismatch");
  }

  const payerSignature = decoded.signatures[expected.payer as Address];
  if (!payerSignature) {
    throw new Error("verifyRequestCloseTransaction: missing payer signature");
  }
  const signatureValid = await verifyEd25519Signature({
    message: decoded.messageBytes as unknown as Uint8Array,
    publicKey: getBase58Encoder().encode(expected.payer) as Uint8Array,
    signature: payerSignature as unknown as Uint8Array,
  });
  if (!signatureValid) {
    throw new Error("verifyRequestCloseTransaction: invalid payer signature");
  }

  const programId = expected.programId ?? PAYMENT_CHANNELS_PROGRAM_ID;
  const maxComputeUnits = Math.min(
    expected.maxComputeUnits ?? OPEN_MAX_COMPUTE_UNIT_LIMIT,
    OPEN_MAX_COMPUTE_UNIT_LIMIT,
  );
  const maxPriorityFee = Math.min(
    expected.maxPriorityFeeMicroLamports ?? MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  );
  let phase: "prefix" | "close" | "suffix" = "prefix";
  let computeLimitSeen = false;
  let computePriceSeen = false;
  let closeSeen = false;
  let memoSeen = false;
  let lighthouseCount = 0;

  for (const ix of message.instructions) {
    const invokedProgram = message.staticAccounts[ix.programAddressIndex];
    if (phase === "prefix" && invokedProgram === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      const data = ix.data;
      if (!data || data.length === 0 || (ix.accountIndices?.length ?? 0) !== 0) {
        throw new Error("invalid Compute Budget instruction");
      }
      if (data[0] === 2) {
        if (computeLimitSeen || computePriceSeen || data.length !== 5) {
          throw new Error("invalid SetComputeUnitLimit instruction");
        }
        const units = new DataView(data.buffer, data.byteOffset + 1, 4).getUint32(0, true);
        if (units > maxComputeUnits) throw new Error("compute unit limit exceeds sponsor cap");
        computeLimitSeen = true;
        continue;
      }
      if (data[0] === 3) {
        if (computePriceSeen || data.length !== 9) {
          throw new Error("invalid SetComputeUnitPrice instruction");
        }
        const price = new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0, true);
        if (price > BigInt(maxPriorityFee))
          throw new Error("compute unit price exceeds sponsor cap");
        computePriceSeen = true;
        continue;
      }
      throw new Error("unsupported Compute Budget instruction");
    }

    if (!closeSeen && invokedProgram === programId) {
      phase = "close";
      const data = ix.data;
      const indices = ix.accountIndices ?? [];
      if (!data || data.length !== 1 || data[0] !== REQUEST_CLOSE_DISCRIMINATOR) {
        throw new Error("verifyRequestCloseTransaction: expected request_close discriminator");
      }
      if (indices.length !== 2) {
        throw new Error("verifyRequestCloseTransaction: request_close must have two accounts");
      }
      const payerIndex = indices[0];
      const channelIndex = indices[1];
      if (
        payerIndex === undefined ||
        channelIndex === undefined ||
        message.staticAccounts[payerIndex] !== expected.payer ||
        message.staticAccounts[channelIndex] !== expected.channelId
      ) {
        throw new Error("verifyRequestCloseTransaction: request_close account binding mismatch");
      }
      const payerRole = staticAccountRole(message, payerIndex);
      const channelRole = staticAccountRole(message, channelIndex);
      if (
        !isSignerRole(payerRole) ||
        isWritableRole(payerRole) ||
        !isWritableRole(channelRole) ||
        isSignerRole(channelRole)
      ) {
        throw new Error("verifyRequestCloseTransaction: request_close account privileges mismatch");
      }
      closeSeen = true;
      continue;
    }

    if (!closeSeen) {
      throw new Error("verifyRequestCloseTransaction: unexpected instruction before request_close");
    }
    phase = "suffix";
    if (invokedProgram === MEMO_PROGRAM_ADDRESS) {
      if (memoSeen || (ix.accountIndices?.length ?? 0) !== 0) {
        throw new Error("verifyRequestCloseTransaction: invalid Memo suffix");
      }
      memoSeen = true;
      const memoData = ix.data ?? new Uint8Array();
      if (memoData.byteLength > MAX_MEMO_BYTES) {
        throw new Error("verifyRequestCloseTransaction: memo exceeds the byte limit");
      }
      if (expected.memo !== undefined) {
        const actual = new TextDecoder().decode(memoData);
        if (actual !== expected.memo)
          throw new Error("verifyRequestCloseTransaction: memo mismatch");
      } else {
        const actual = new TextDecoder().decode(memoData);
        if (!/^[0-9a-f]{32,}$/i.test(actual)) {
          throw new Error("verifyRequestCloseTransaction: nonce memo must be hexadecimal");
        }
      }
      continue;
    }
    if (invokedProgram === LIGHTHOUSE_PROGRAM_ADDRESS) {
      lighthouseCount += 1;
      if (lighthouseCount > MAX_LIGHTHOUSE_INSTRUCTIONS) {
        throw new Error("verifyRequestCloseTransaction: too many Lighthouse instructions");
      }
      rejectFeePayerReference(ix, message.staticAccounts, expected.feePayer);
      continue;
    }
    throw new Error("verifyRequestCloseTransaction: unsupported suffix instruction");
  }
  if (!closeSeen) throw new Error("verifyRequestCloseTransaction: missing request_close");
}

function requestMemo(value: string | undefined): Uint8Array {
  if (value !== undefined) {
    const encoded = new TextEncoder().encode(value);
    if (encoded.byteLength > MAX_MEMO_BYTES) {
      throw new Error(`extra.memo exceeds maximum ${MAX_MEMO_BYTES} bytes`);
    }
    return encoded;
  }
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return new TextEncoder().encode(
    Array.from(nonce)
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join(""),
  );
}

function rejectFeePayerReference(
  ix: { accountIndices?: readonly number[]; programAddressIndex: number },
  staticAccounts: readonly string[],
  feePayer: string,
): void {
  if (staticAccounts[ix.programAddressIndex] === feePayer) {
    throw new Error("verifyRequestCloseTransaction: feePayer must not be an invoked program");
  }
  if ((ix.accountIndices ?? []).some(index => staticAccounts[index] === feePayer)) {
    throw new Error("verifyRequestCloseTransaction: feePayer must not be a suffix account");
  }
}

function staticAccountRole(message: CompiledMessage, index: number): AccountRole {
  const { header } = message;
  const writableSigners = header.numSignerAccounts - header.numReadonlySignerAccounts;
  const writableNonSigners =
    message.staticAccounts.length - header.numSignerAccounts - header.numReadonlyNonSignerAccounts;
  if (index < writableSigners) return AccountRole.WRITABLE_SIGNER;
  if (index < header.numSignerAccounts) return AccountRole.READONLY_SIGNER;
  if (index < header.numSignerAccounts + writableNonSigners) return AccountRole.WRITABLE;
  return AccountRole.READONLY;
}
