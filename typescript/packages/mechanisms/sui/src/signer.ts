// Portions copyright 2026 Danny Devs (https://github.com/Danny-Devs/x402-sui), Apache-2.0

import type { SuiJsonRpcClient, DryRunTransactionBlockResponse } from "@mysten/sui/jsonRpc";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Signer } from "@mysten/sui/cryptography";
import type { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";
import type { Network } from "@x402/core/types";
import { createSuiClient } from "./utils";

/**
 * Client-side signer for creating and signing Sui transactions.
 * Any Sui signer works: Ed25519Keypair, Secp256k1Keypair, browser wallet adapter.
 */
export interface ClientSuiSigner {
  /**
   * The sender's Sui address.
   */
  readonly address: string;

  /**
   * Sign a transaction without executing it.
   *
   * @param transaction - The Transaction to sign
   * @returns Signature and serialized transaction bytes (both Base64-encoded)
   */
  signTransaction(transaction: Transaction): Promise<{ signature: string; bytes: string }>;
}

/**
 * Facilitator-side signer for verifying, simulating, and broadcasting Sui
 * transactions. Encapsulates SuiClient operations. On the gasless path there is
 * no sponsor key — the facilitator only relays the payer's already-signed bytes.
 */
export interface FacilitatorSuiSigner {
  /**
   * Get all addresses this facilitator can broadcast from. Empty on the gasless
   * path (keyless broadcast — there is no sponsor key).
   *
   * @returns Array of Sui addresses
   */
  getAddresses(): readonly string[];

  /**
   * Verify a signature over transaction bytes and recover the signer's address.
   * Supports Ed25519, Secp256k1, and Secp256r1 signatures.
   *
   * @param transactionBytes - Base64-encoded transaction bytes
   * @param signature - Base64-encoded signature
   * @param network - CAIP-2 network identifier
   * @returns The recovered signer's Sui address
   */
  verifySignature(transactionBytes: string, signature: string, network: string): Promise<string>;

  /**
   * Dry-run a transaction to check it would succeed. Returns the full
   * DryRunTransactionBlockResponse including `balanceChanges`.
   *
   * @param transactionBytes - Base64-encoded transaction bytes
   * @param network - CAIP-2 network identifier
   * @returns Dry-run result with balance changes, effects, and events
   */
  simulateTransaction(
    transactionBytes: string,
    network: string,
  ): Promise<DryRunTransactionBlockResponse>;

  /**
   * Look up whether a transaction digest is already committed on-chain. This is the
   * stateless replay guard: simulation is NOT sufficient for gasless Address-Balance
   * transactions (they carry no object inputs, so re-simulating already-executed bytes
   * still succeeds). The facilitator computes the digest from the signed bytes and
   * asks the chain directly.
   *
   * @param digest - The transaction digest to look up
   * @param network - CAIP-2 network identifier
   * @returns `true` when the digest is already committed on-chain, `false` otherwise
   */
  isTransactionExecuted(digest: string, network: string): Promise<boolean>;

  /**
   * Execute a signed transaction on-chain.
   *
   * @param transaction - Base64-encoded transaction bytes
   * @param signature - Base64-encoded signature(s): a single string, or an array
   * @param network - CAIP-2 network identifier
   * @returns Transaction digest
   */
  executeTransaction(
    transaction: string,
    signature: string | string[],
    network: string,
  ): Promise<string>;

  /**
   * Wait for transaction finality.
   *
   * @param digest - Transaction digest to wait for
   * @param network - CAIP-2 network identifier
   */
  waitForTransaction(digest: string, network: string): Promise<void>;
}

/**
 * Configuration for the facilitator signer.
 */
export interface FacilitatorSuiSignerConfig {
  /**
   * Optional custom RPC URL applied to every network.
   */
  rpcUrl?: string;

  /**
   * Optional per-network RPC URL mapping (keyed by CAIP-2 id).
   */
  rpcUrls?: Record<string, string>;
}

/**
 * Create a FacilitatorSuiSigner from optional RPC config and an optional keypair.
 * The keypair is only needed for the classic sponsored `Coin<T>` path; the
 * gasless path is keyless and needs none.
 *
 * @param config - Optional configuration (custom RPC URLs)
 * @param keypair - Optional keypair (only for the classic sponsored path)
 * @returns A FacilitatorSuiSigner instance
 */
export function toFacilitatorSuiSigner(
  config?: FacilitatorSuiSignerConfig,
  keypair?: Signer,
): FacilitatorSuiSigner {
  const clientCache = new Map<string, SuiJsonRpcClient>();

  const getClient = (network: string): SuiJsonRpcClient => {
    const cached = clientCache.get(network);
    if (cached) return cached;

    const rpcUrl = config?.rpcUrls?.[network] ?? config?.rpcUrl;
    const client = createSuiClient(network as Network, rpcUrl);
    clientCache.set(network, client);
    return client;
  };

  return {
    getAddresses(): readonly string[] {
      if (!keypair) return [];
      return [keypair.toSuiAddress()];
    },

    async verifySignature(transactionBytes: string, signature: string, _: string): Promise<string> {
      const txBytes = fromBase64(transactionBytes);
      const publicKey = await verifyTransactionSignature(txBytes, signature);
      return publicKey.toSuiAddress();
    },

    async simulateTransaction(
      transactionBytes: string,
      network: string,
    ): Promise<DryRunTransactionBlockResponse> {
      const client = getClient(network);
      return await client.dryRunTransactionBlock({
        transactionBlock: transactionBytes,
      });
    },

    async isTransactionExecuted(digest: string, network: string): Promise<boolean> {
      const client = getClient(network);
      try {
        const tx = await client.getTransactionBlock({ digest });
        return tx?.digest === digest;
      } catch {
        // An unknown digest (never committed) makes the node return an error — the
        // transaction is not on-chain. Treat any lookup failure as "not executed".
        return false;
      }
    },

    async executeTransaction(
      transaction: string,
      signature: string | string[],
      network: string,
    ): Promise<string> {
      const client = getClient(network);

      const result = await client.executeTransactionBlock({
        transactionBlock: transaction,
        signature,
        options: {
          showEffects: true,
        },
      });

      if (result.effects?.status?.status !== "success") {
        throw new Error(
          `Transaction execution failed: ${result.effects?.status?.error || "unknown error"}`,
        );
      }

      return result.digest;
    },

    async waitForTransaction(digest: string, network: string): Promise<void> {
      const client = getClient(network);
      await client.waitForTransaction({
        digest,
        options: { showEffects: true },
      });
    },
  };
}

/**
 * Convert any Sui keypair to a ClientSuiSigner. Works with Ed25519Keypair,
 * Secp256k1Keypair, etc. Signs but never executes — the facilitator broadcasts.
 *
 * @param keypair - Any Sui cryptographic keypair
 * @param client - A Sui client (JSON-RPC or gRPC) for building transactions
 * @returns A ClientSuiSigner instance
 */
export function toClientSuiSigner(
  keypair: Signer,
  client: SuiJsonRpcClient | SuiGrpcClient,
): ClientSuiSigner {
  return {
    address: keypair.toSuiAddress(),

    async signTransaction(transaction: Transaction): Promise<{ signature: string; bytes: string }> {
      const txBytes = await transaction.build({ client });
      const { signature } = await keypair.signTransaction(txBytes);
      const bytes = toBase64(txBytes);
      return { signature, bytes };
    },
  };
}
