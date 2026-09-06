/**
 * Local Ed25519 verification of required transaction signers.
 *
 * Replaces RPC-side `sigVerify` during facilitator verify: the fee-payer slot
 * is unsigned until settle, so simulation runs with sigVerify off. Every other
 * required signer is checked here over `transaction.messageBytes`.
 */

import { getAddressEncoder, verifySignature, type Address, type Transaction } from "@solana/kit";
import * as Errors from "./errors";

const addressEncoder = getAddressEncoder();

export type CompiledSignerAccounts = {
  header: { numSignerAccounts: number };
  staticAccounts: readonly { toString(): string }[];
};

export type SignatureVerificationResult = { ok: true } | { ok: false; invalidReason: string };

/**
 * Asserts account 0 is the advertised fee payer, then verifies Ed25519
 * signatures for signer indices 1..numSignerAccounts-1.
 *
 * Index 0 is skipped: the facilitator fills that slot at settle time.
 *
 * @param transaction - Decoded transaction whose signatures to check
 * @param compiled - Compiled message (header + static accounts)
 * @param expectedFeePayer - Fee payer from payment requirements
 * @returns ok, or an invalid reason
 */
export async function verifyRequiredSignatures(
  transaction: Transaction,
  compiled: CompiledSignerAccounts,
  expectedFeePayer: string,
): Promise<SignatureVerificationResult> {
  const feePayerAccount = compiled.staticAccounts[0]?.toString();
  if (!feePayerAccount || feePayerAccount !== expectedFeePayer) {
    return { ok: false, invalidReason: Errors.ErrFeePayerMismatch };
  }

  const numSigners = compiled.header.numSignerAccounts;
  const checks: Promise<boolean>[] = [];

  for (let i = 1; i < numSigners; i++) {
    const address = compiled.staticAccounts[i]?.toString();
    if (!address) {
      return { ok: false, invalidReason: Errors.ErrSignatureInvalid };
    }

    const signature = transaction.signatures[address as Address];
    if (!signature || signature.length !== 64) {
      return { ok: false, invalidReason: Errors.ErrSignatureInvalid };
    }

    checks.push(verifyEd25519(address, signature, transaction.messageBytes));
  }

  const results = await Promise.all(checks);
  if (results.some(valid => !valid)) {
    return { ok: false, invalidReason: Errors.ErrSignatureInvalid };
  }

  return { ok: true };
}

/**
 * Verifies one Ed25519 signature over the transaction message bytes.
 *
 * @param address - Base58 signer address (raw 32-byte public key)
 * @param signature - 64-byte Ed25519 signature
 * @param messageBytes - Transaction message bytes the signature covers
 * @returns Whether the signature is valid
 */
async function verifyEd25519(
  address: string,
  signature: Uint8Array,
  messageBytes: Uint8Array,
): Promise<boolean> {
  try {
    const publicKeyBytes = addressEncoder.encode(address as Address);
    const publicKey = await crypto.subtle.importKey("raw", publicKeyBytes, "Ed25519", false, [
      "verify",
    ]);
    return await verifySignature(publicKey, signature, messageBytes);
  } catch {
    return false;
  }
}
