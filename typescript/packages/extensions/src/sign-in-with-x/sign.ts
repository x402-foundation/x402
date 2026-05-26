/**
 * Message signing for SIWX extension
 *
 * Client-side helpers for signing SIWX messages.
 * Supports both EVM (viem) and Solana wallet adapters.
 */

import { encodeBase58 } from "./solana";

/**
 * Signer interface for EVM SIWX message signing.
 * Compatible with viem WalletClient and PrivateKeyAccount.
 */
export interface EVMSigner {
  /** Sign a message and return hex-encoded signature */
  signMessage: (args: { message: string; account?: unknown }) => Promise<string>;
  /** Account object (for WalletClient) */
  account?: { address: string };
  /** Direct address (for PrivateKeyAccount) */
  address?: string;
}

/**
 * Wallet adapter style Solana signer.
 * Compatible with @solana/wallet-adapter, Phantom/Solflare wallet APIs.
 */
export interface WalletAdapterSigner {
  /** Sign a message and return raw signature bytes */
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  /** Solana public key (Base58 encoded string or PublicKey-like object) */
  publicKey: string | { toBase58: () => string };
}

/**
 * Solana Kit KeyPairSigner style.
 * Compatible with createKeyPairSignerFromBytes and generateKeyPairSigner from @solana/kit.
 */
export type SolanaKitSigner = {
  /** Solana address (Base58 encoded string) */
  address: string;
  /** Sign messages - accepts messages with content and signatures */
  signMessages: (
    messages: Array<{ content: Uint8Array; signatures: Record<string, unknown> }>,
  ) => Promise<Array<Record<string, Uint8Array>>>;
};

/**
 * Union type for Solana signers - supports both wallet adapter and @solana/kit.
 */
export type SolanaSigner = WalletAdapterSigner | SolanaKitSigner;

/**
 * Union type for SIWX signers - supports both EVM and Solana wallets.
 */
export type SIWxSigner = EVMSigner | SolanaSigner;

/**
 * Get address from an EVM signer.
 *
 * @param signer - EVM wallet signer instance
 * @returns The wallet address as a hex string
 */
export function getEVMAddress(signer: EVMSigner): string {
  if (signer.account?.address) {
    return signer.account.address;
  }
  if (signer.address) {
    return signer.address;
  }
  throw new Error("EVM signer missing address");
}

/**
 * Get address from a Solana signer.
 * Supports both wallet adapter (publicKey) and @solana/kit (address) interfaces.
 *
 * @param signer - Solana wallet signer instance
 * @returns The wallet address as a Base58 string
 */
export function getSolanaAddress(signer: SolanaSigner): string {
  // Check for @solana/kit KeyPairSigner interface (address property)
  if ("address" in signer && signer.address) {
    return signer.address;
  }
  // Fall back to wallet adapter interface (publicKey property)
  if ("publicKey" in signer) {
    const pk = signer.publicKey;
    return typeof pk === "string" ? pk : pk.toBase58();
  }
  throw new Error("Solana signer missing address or publicKey");
}

/**
 * Sign a message with an EVM wallet.
 * Returns hex-encoded signature.
 *
 * @param message - The message to sign
 * @param signer - EVM wallet signer instance
 * @returns Hex-encoded signature
 */
export async function signEVMMessage(message: string, signer: EVMSigner): Promise<string> {
  if (signer.account) {
    return signer.signMessage({ message, account: signer.account });
  }
  return signer.signMessage({ message });
}

/**
 * Sign a message with a Solana wallet.
 * Returns Base58-encoded signature.
 * Supports both wallet adapter (signMessage) and @solana/kit (signMessages) interfaces.
 *
 * @param message - The message to sign
 * @param signer - Solana wallet signer instance
 * @returns Base58-encoded signature
 */
export async function signSolanaMessage(message: string, signer: SolanaSigner): Promise<string> {
  const messageBytes = new TextEncoder().encode(message);

  // Check for @solana/kit signMessages interface
  if ("signMessages" in signer) {
    const results = await signer.signMessages([{ content: messageBytes, signatures: {} }]);
    // signMessages returns an array of signature dictionaries
    // The signature is keyed by the signer's address
    const sigDict = results[0] as { [key: string]: Uint8Array };
    // Get the first (and only) signature value from the dictionary
    const signatureBytes = Object.values(sigDict)[0];
    return encodeBase58(signatureBytes);
  }

  // Fall back to wallet adapter signMessage interface
  if ("signMessage" in signer) {
    const signatureBytes = await signer.signMessage(messageBytes);
    return encodeBase58(signatureBytes);
  }

  throw new Error("Solana signer missing signMessage or signMessages method");
}
