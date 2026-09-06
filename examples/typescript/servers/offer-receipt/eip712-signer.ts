import { privateKeyToAccount } from "viem/accounts";
import type { SignTypedDataFn } from "@x402/extensions/offer-receipt";

export interface EIP712SignerResult {
  signTypedData: SignTypedDataFn;
  address: `0x${string}`;
}

/**
 * Create an EIP-712 signer from a hex private key
 *
 * For production, use a proper key management solution (HSM, KMS, etc.)
 * This is a simple implementation for demonstration purposes.
 *
 * @param privateKeyHex - Hex-encoded secp256k1 private key (with or without 0x prefix).
 *   EIP-712 only supports secp256k1 keys (Ethereum's curve).
 * @returns EIP712SignerResult containing the signTypedData function and address
 */
export function createEIP712SignerFromPrivateKey(privateKeyHex: string): EIP712SignerResult {
  // Ensure 0x prefix
  const normalizedKey = privateKeyHex.startsWith("0x")
    ? (privateKeyHex as `0x${string}`)
    : (`0x${privateKeyHex}` as `0x${string}`);

  const account = privateKeyToAccount(normalizedKey);

  return {
    signTypedData: account.signTypedData.bind(account) as SignTypedDataFn,
    address: account.address,
  };
}
