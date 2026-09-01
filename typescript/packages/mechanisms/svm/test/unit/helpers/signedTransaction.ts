/**
 * Builds genuinely signed v0 transactions for facilitator unit tests.
 * Local Ed25519 verification rejects the placeholder 64-byte signatures the
 * older fixtures used.
 */

import { getBase64EncodedWireTransaction, type Address, type TransactionSigner } from "@solana/kit";

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
