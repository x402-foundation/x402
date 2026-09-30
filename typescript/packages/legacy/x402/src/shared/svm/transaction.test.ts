/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getBase64Encoder,
  getTransactionDecoder,
  Address,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  partiallySignTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  generateKeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { ExactSvmPayload } from "../../types/verify";
import { decodeTransactionFromPayload, getTokenPayerFromTransaction } from "./transaction";
import * as solanaKit from "@solana/kit";

vi.mock("@solana/kit", async importOriginal => {
  const actual = await importOriginal<typeof solanaKit>();
  return {
    ...actual,
    getBase64Encoder: vi.fn(),
    getTransactionDecoder: vi.fn(),
    getCompiledTransactionMessageDecoder: vi.fn(),
  };
});

describe("decodeTransactionFromPayload", () => {
  it("should decode a valid transaction string", () => {
    const mockDecodedTransaction = { signature: "a_valid_signature" };
    const encodeFn = vi.fn().mockReturnValue(new Uint8Array());
    const decodeFn = vi.fn().mockReturnValue(mockDecodedTransaction);

    vi.mocked(getBase64Encoder).mockReturnValue({
      encode: encodeFn,
      write: vi.fn(),
    } as any);
    vi.mocked(getTransactionDecoder).mockReturnValue({
      decode: decodeFn,
      read: vi.fn(),
    } as any);

    const svmPayload: ExactSvmPayload = {
      transaction: "a_valid_transaction_string",
    };

    const result = decodeTransactionFromPayload(svmPayload);
    expect(result).toEqual(mockDecodedTransaction);
    expect(encodeFn).toHaveBeenCalledWith("a_valid_transaction_string");
    expect(decodeFn).toHaveBeenCalled();
  });

  it("should throw an error for an invalid transaction string", () => {
    const encodeFn = vi.fn().mockImplementation(() => {
      throw new Error("Encoding failed");
    });
    vi.mocked(getBase64Encoder).mockReturnValue({
      encode: encodeFn,
      write: vi.fn(),
    } as any);

    const svmPayload: ExactSvmPayload = {
      transaction: "an_invalid_transaction_string",
    };

    expect(() => decodeTransactionFromPayload(svmPayload)).toThrow(
      "invalid_exact_svm_payload_transaction",
    );
  });
});

describe("getTokenPayerFromTransaction", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("@solana/kit")>("@solana/kit");
    vi.mocked(getBase64Encoder).mockImplementation(actual.getBase64Encoder);
    vi.mocked(getTransactionDecoder).mockImplementation(actual.getTransactionDecoder);
    vi.mocked(solanaKit.getCompiledTransactionMessageDecoder).mockImplementation(
      actual.getCompiledTransactionMessageDecoder,
    );
  });

  it("extracts owner for SPL Token TransferChecked", async () => {
    const authority = await generateKeyPairSigner();
    const payTo = (await generateKeyPairSigner()).address as Address;
    const mint = (await generateKeyPairSigner()).address as Address;

    const base64Tx = await buildSignedBase64TransferTx(
      authority,
      payTo,
      mint,
      TOKEN_PROGRAM_ADDRESS,
    );

    const decoder = getTransactionDecoder();
    const b64 = getBase64Encoder();
    const transaction = decoder.decode(b64.encode(base64Tx));

    const payer = getTokenPayerFromTransaction(transaction);
    expect(payer).toBe(authority.address);
  });

  it("extracts owner for Token-2022 TransferChecked", async () => {
    const authority = await generateKeyPairSigner();
    const payTo = (await generateKeyPairSigner()).address as Address;
    const mint = (await generateKeyPairSigner()).address as Address;

    const base64Tx = await buildSignedBase64TransferTx(
      authority,
      payTo,
      mint,
      TOKEN_2022_PROGRAM_ADDRESS,
    );

    const decoder = getTransactionDecoder();
    const b64 = getBase64Encoder();
    const transaction = decoder.decode(b64.encode(base64Tx));

    const payer = getTokenPayerFromTransaction(transaction);
    expect(payer).toBe(authority.address);
  });
});

/**
 * Build, sign, and encode a minimal TransferChecked transaction for tests.
 *
 * Creates source/destination ATAs for the provided mint and owners, sets a distinct
 * fee payer, attaches a dummy blockhash lifetime, signs the message, and returns
 * the base64-encoded wire transaction.
 *
 * @param authority - The token authority whose address appears as the owner in the transfer
 * @param payTo - The recipient account owner for the destination associated token account
 * @param mint - The token mint address for which to derive ATAs
 * @param tokenProgram - The token program address (SPL Token or Token-2022)
 * @returns The base64-encoded wire transaction string
 */
async function buildSignedBase64TransferTx(
  authority: TransactionSigner,
  payTo: Address,
  mint: Address,
  tokenProgram: Address,
) {
  const [sourceATA] = await findAssociatedTokenPda({
    mint,
    owner: authority.address,
    tokenProgram,
  });

  const [destinationATA] = await findAssociatedTokenPda({
    mint,
    owner: payTo,
    tokenProgram,
  });

  const transferIx = getTransferCheckedInstruction(
    {
      source: sourceATA,
      mint,
      destination: destinationATA,
      authority,
      amount: 1n,
      decimals: 6,
    },
    { programAddress: tokenProgram },
  );

  const feePayer = (await generateKeyPairSigner()).address;
  const message = appendTransactionMessageInstructions(
    [transferIx],
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: "11111111111111111111111111111111" as any, lastValidBlockHeight: 123456n },
      setTransactionMessageFeePayer(feePayer, createTransactionMessage({ version: 0 })),
    ),
  );

  const signedMessage = await partiallySignTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(signedMessage);
}
