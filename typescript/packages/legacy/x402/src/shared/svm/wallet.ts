import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  type RpcDevnet,
  type SolanaRpcApiDevnet,
  type RpcMainnet,
  type SolanaRpcApiMainnet,
  type TransactionSigner,
  isTransactionSigner,
} from "@solana/kit";
import { base58 } from "@scure/base";
import { getRpcClient } from "./rpc";
import { Network, SupportedSVMNetworks } from "../../types/shared";
export type { KeyPairSigner } from "@solana/kit";

export type SvmConnectedClient = RpcDevnet<SolanaRpcApiDevnet> | RpcMainnet<SolanaRpcApiMainnet>;
export type SvmSigner = TransactionSigner;

/**
 * Creates a public client configured for the specified SVM network
 *
 * @param network - The network to connect to
 * @returns A public client instance connected to the specified chain
 */
export function createSvmConnectedClient(network: string): SvmConnectedClient {
  if (!SupportedSVMNetworks.find(n => n === network)) {
    throw new Error(`Unsupported SVM network: ${network}`);
  }
  return getRpcClient(network as Network);
}

/**
 * Creates a Solana signer from a private key.
 *
 * @param privateKey - The base58 encoded private key to create a signer from.
 * @returns A Solana signer.
 */
export async function createSignerFromBase58(privateKey: string): Promise<TransactionSigner> {
  // decode the base58 encoded private key
  const bytes = base58.decode(privateKey);

  // generate a keypair signer from the bytes based on the byte-length
  // 64 bytes represents concatenated private + public key
  if (bytes.length === 64) {
    return await createKeyPairSignerFromBytes(bytes);
  }
  // 32 bytes represents only the private key
  if (bytes.length === 32) {
    return await createKeyPairSignerFromPrivateKeyBytes(bytes);
  }
  throw new Error(`Unexpected key length: ${bytes.length}. Expected 32 or 64 bytes.`);
}

/**
 * Checks if the given wallet is a Solana transaction signer wallet.
 *
 * @param wallet - The object wallet to check.
 * @returns True if the wallet satisfies the TransactionSigner interface.
 */
export function isSignerWallet(wallet: unknown): wallet is SvmSigner {
  return (
    typeof wallet === "object" &&
    wallet !== null &&
    isTransactionSigner(wallet as TransactionSigner)
  );
}
