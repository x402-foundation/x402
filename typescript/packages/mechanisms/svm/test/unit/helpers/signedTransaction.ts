/**
 * Builds genuinely signed v0 transactions for facilitator unit tests.
 * Local Ed25519 verification rejects the placeholder 64-byte signatures the
 * older fixtures used.
 */

import {
  getSetComputeUnitLimitInstruction,
  setTransactionMessageComputeUnitPrice,
} from "@solana-program/compute-budget";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { findAssociatedTokenPda, getTransferCheckedInstruction } from "@solana-program/token-2022";
import {
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  createTransactionMessage,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  partiallySignTransaction,
  pipe,
  prependTransactionMessageInstruction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type TransactionSigner,
} from "@solana/kit";
import { MEMO_PROGRAM_ADDRESS } from "../../../src/constants";

export type MessageSigner = Pick<TransactionSigner, "address" | "signMessages">;

/**
 * Encodes a compiled message with real Ed25519 signatures from `signers`.
 * The fee-payer slot (account 0) may be left as zeros — verify skips that index.
 *
 * @param messageBytes - Compiled transaction message bytes
 * @param signers - Keypairs that must sign (typically every required signer except the fee payer)
 * @param extraSignatures - Optional extra/placeholder signatures (e.g. fee payer zeros)
 * @returns Base64 wire transaction
 */
export async function encodeSignedTransaction(
  messageBytes: Uint8Array,
  signers: readonly MessageSigner[],
  extraSignatures: Record<string, Uint8Array> = {},
): Promise<string> {
  const signatures: Record<string, Uint8Array> = { ...extraSignatures };

  await Promise.all(
    signers.map(async signer => {
      const [dict] = await signer.signMessages([
        { content: messageBytes, signatures: {} } as never,
      ]);
      Object.assign(signatures, dict);
    }),
  );

  return getBase64EncodedWireTransaction({ messageBytes, signatures } as never);
}

/**
 * Placeholder fee-payer signature. Verify skips index 0; settle overwrites it.
 *
 * @param feePayer - Fee payer address
 * @returns Signature map with a 64-byte zero signature
 */
export function placeholderFeePayerSignature(feePayer: Address): Record<string, Uint8Array> {
  return { [feePayer]: new Uint8Array(64) };
}

/**
 * Decode a wire transaction, apply a compiled-message mutation, and re-sign
 * with the payer so signature verification still passes.
 *
 * @param payer - Payer keypair that originally signed the transfer
 * @param transactionBase64 - Base64 wire transaction to mutate
 * @param mutate - In-place compiled-message mutation
 * @returns Base64 wire transaction with the payer signature refreshed
 */
export async function resignMutatedTransaction(
  payer: TransactionSigner & { keyPair: CryptoKeyPair },
  transactionBase64: string,
  mutate: (compiled: {
    instructions: {
      accountIndices?: number[];
      data?: Uint8Array;
      programAddressIndex: number;
    }[];
    staticAccounts: string[];
  }) => void,
): Promise<string> {
  const decoded = getTransactionDecoder().decode(getBase64Codec().encode(transactionBase64));
  const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  const mutable = {
    instructions: compiled.instructions.map(ix => ({
      accountIndices: ix.accountIndices ? [...ix.accountIndices] : undefined,
      data: ix.data ? new Uint8Array(ix.data) : undefined,
      programAddressIndex: ix.programAddressIndex,
    })),
    staticAccounts: [...compiled.staticAccounts],
  };
  mutate(mutable);
  const messageBytes = getCompiledTransactionMessageEncoder().encode({
    ...compiled,
    instructions: mutable.instructions,
    staticAccounts: mutable.staticAccounts as typeof compiled.staticAccounts,
  });
  const signed = await partiallySignTransaction([payer.keyPair], {
    messageBytes,
    signatures: Object.fromEntries(Object.keys(decoded.signatures).map(addr => [addr, null])),
  } as never);
  return getBase64EncodedWireTransaction(signed);
}

const FAKE_BLOCKHASH = {
  blockhash: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" as Blockhash,
  lastValidBlockHeight: 1000n,
};

/**
 * Build a standard-wallet exact payment: compute budget + TransferChecked + memo.
 *
 * @param args - Transfer fields and optional memo text
 * @returns Base64 wire transaction signed by the token authority
 */
export async function buildExactPaymentTransaction(args: {
  amount: bigint;
  feePayer: Address;
  mint: Address;
  payTo: Address;
  payer: MessageSigner;
  extraInstructions?: Parameters<typeof appendTransactionMessageInstructions>[0];
  includeMemo?: boolean;
  memo?: string;
  tokenProgram?: Address;
}): Promise<string> {
  const tokenProgram = args.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
  const [sourceATA] = await findAssociatedTokenPda({
    mint: args.mint,
    owner: args.payer.address,
    tokenProgram,
  });
  const [destinationATA] = await findAssociatedTokenPda({
    mint: args.mint,
    owner: args.payTo,
    tokenProgram,
  });
  const transferIx = getTransferCheckedInstruction(
    {
      amount: args.amount,
      authority: args.payer,
      destination: destinationATA,
      decimals: 6,
      mint: args.mint,
      source: sourceATA,
    },
    { programAddress: tokenProgram },
  );
  const trailing = [...(args.extraInstructions ?? [])];
  if (args.includeMemo !== false) {
    trailing.unshift({
      programAddress: MEMO_PROGRAM_ADDRESS as Address,
      accounts: [] as const,
      data: new TextEncoder().encode(args.memo ?? "nonce"),
    });
  }
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageComputeUnitPrice(1, m),
    m => setTransactionMessageFeePayer(args.feePayer, m),
    m =>
      prependTransactionMessageInstruction(getSetComputeUnitLimitInstruction({ units: 20_000 }), m),
    m => appendTransactionMessageInstructions([transferIx, ...trailing], m),
    m => setTransactionMessageLifetimeUsingBlockhash(FAKE_BLOCKHASH, m),
  );
  const messageBytes = getCompiledTransactionMessageEncoder().encode(
    compileTransactionMessage(msg),
  );
  return encodeSignedTransaction(
    messageBytes,
    [args.payer],
    placeholderFeePayerSignature(args.feePayer),
  );
}
