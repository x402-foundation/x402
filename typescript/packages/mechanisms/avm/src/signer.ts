/**
 * AVM (Algorand) Signer Interfaces for x402 Payment Protocol
 *
 * This module defines the signer interfaces for client and facilitator operations.
 * Use the `toClientAvmSigner` and `toFacilitatorAvmSigner` helper functions to create
 * signers from a Base64-encoded private key.
 *
 * @example Client signer:
 * ```typescript
 * import { toClientAvmSigner } from "@x402/avm";
 *
 * const signer = toClientAvmSigner(process.env.AVM_PRIVATE_KEY!);
 * ```
 *
 * @example Facilitator signer:
 * ```typescript
 * import { toFacilitatorAvmSigner } from "@x402/avm";
 *
 * const signer = toFacilitatorAvmSigner(process.env.AVM_PRIVATE_KEY!);
 * ```
 */

import { AlgorandClient } from "@algorandfoundation/algokit-utils/algorand-client";
import { ed25519Generator } from "@algorandfoundation/algokit-utils/crypto";
import {
  decodeTransaction,
  generateAddressWithSigners,
} from "@algorandfoundation/algokit-utils/transact";
import type {
  AddressWithSigners,
  AddressWithTransactionSigner,
} from "@algorandfoundation/algokit-utils/transact";
import { waitForConfirmation } from "@algorandfoundation/algokit-utils/transaction";
import type { Network } from "@x402/core/types";
import { ALGORAND_TESTNET_CAIP2 } from "./constants";

/**
 * Symbol key used to attach the internal algokit-utils AddressWithSigners
 * to a ClientAvmSigner created via toClientAvmSigner().
 * This enables internal code to extract the native algokit signer for
 * use with TransactionComposer and AlgorandClient.
 */
export const ALGOKIT_SIGNER = Symbol("algokit-signer");

/**
 * Client-side signer interface for Algorand wallets
 *
 * Compatible with @txnlab/use-wallet and similar wallet libraries.
 * Used to sign payment transactions on the client side.
 */
export interface ClientAvmSigner {
  /**
   * The Algorand address of the signer
   */
  address: string;

  /**
   * Sign one or more transactions
   *
   * @param txns - Array of unsigned transactions (encoded as Uint8Array)
   * @param indexesToSign - Optional array of indexes to sign (if not provided, sign all)
   * @returns Promise resolving to array of signed transactions (null for unsigned)
   */
  signTransactions(txns: Uint8Array[], indexesToSign?: number[]): Promise<(Uint8Array | null)[]>;
}

/**
 * Configuration for client AVM operations
 */
export interface ClientAvmConfig {
  /**
   * Pre-configured AlgorandClient instance (takes precedence over URL/token)
   * Use AlgorandClient.testNet(), .mainNet(), .fromConfig(), etc.
   */
  algorandClient?: import("@algorandfoundation/algokit-utils/algorand-client").AlgorandClient;

  /**
   * Algod API URL (used if algorandClient not provided)
   */
  algodUrl?: string;

  /**
   * Algod API token
   */
  algodToken?: string;
}

/**
 * Facilitator signer interface for Algorand operations
 *
 * Used by the facilitator to verify and settle payments.
 * Supports multiple addresses for load balancing and key rotation.
 *
 * @example Using the helper function:
 * ```typescript
 * import { toFacilitatorAvmSigner } from "@x402/avm";
 *
 * const signer = toFacilitatorAvmSigner(process.env.AVM_PRIVATE_KEY!);
 * ```
 */
export interface FacilitatorAvmSigner {
  /**
   * Get all addresses this facilitator can use as fee payers
   *
   * @returns Array of Algorand addresses
   */
  getAddresses(): readonly string[];

  /**
   * Sign a transaction with the signer matching the sender address
   *
   * @param txn - Transaction bytes to sign
   * @param senderAddress - Expected sender address (for verification)
   * @returns Promise resolving to signed transaction bytes
   */
  signTransaction(txn: Uint8Array, senderAddress: string): Promise<Uint8Array>;

  /**
   * Get Algod client for a specific network
   *
   * @param network - Network identifier (CAIP-2 or V1 format)
   * @returns AlgodClient instance from @algorandfoundation/algokit-utils
   */
  getAlgodClient(
    network: Network,
  ): import("@algorandfoundation/algokit-utils/algod-client").AlgodClient;

  /**
   * Simulate a transaction group before submission
   *
   * @param txns - Array of signed transaction bytes
   * @param network - Network identifier
   * @returns Promise resolving to SimulateResponse
   */
  simulateTransactions(
    txns: Uint8Array[],
    network: Network,
  ): Promise<import("@algorandfoundation/algokit-utils/algod-client").SimulateResponse>;

  /**
   * Submit signed transactions to the network
   *
   * @param signedTxns - Array of signed transaction bytes
   * @param network - Network identifier
   * @returns Promise resolving to transaction ID
   */
  sendTransactions(signedTxns: Uint8Array[], network: Network): Promise<string>;

  /**
   * Wait for a transaction to be confirmed
   *
   * @param txId - Transaction ID
   * @param network - Network identifier
   * @param waitRounds - Number of rounds to wait (default: 4)
   * @returns Promise resolving to PendingTransactionResponse
   */
  waitForConfirmation(
    txId: string,
    network: Network,
    waitRounds?: number,
  ): Promise<import("@algorandfoundation/algokit-utils/algod-client").PendingTransactionResponse>;
}

/**
 * Configuration for creating a facilitator signer
 */
export interface FacilitatorAvmSignerConfig {
  /**
   * Algod URL for mainnet
   */
  mainnetUrl?: string;

  /**
   * Algod URL for testnet
   */
  testnetUrl?: string;

  /**
   * Algod API token
   */
  algodToken?: string;
}

/**
 * Type guard to check if a wallet implements ClientAvmSigner
 *
 * @param wallet - The wallet to check
 * @returns True if the wallet implements ClientAvmSigner
 */
export function isAvmSignerWallet(wallet: unknown): wallet is ClientAvmSigner {
  return (
    typeof wallet === "object" &&
    wallet !== null &&
    "address" in wallet &&
    typeof (wallet as ClientAvmSigner).address === "string" &&
    "signTransactions" in wallet &&
    typeof (wallet as ClientAvmSigner).signTransactions === "function"
  );
}

/**
 * Decodes a Base64-encoded 64-byte private key into address and raw Ed25519 signer.
 *
 * @param privateKeyBase64 - Base64-encoded 64-byte key (32-byte seed + 32-byte public key)
 * @returns Address and raw Ed25519 signer function
 */
function decodePrivateKey(privateKeyBase64: string) {
  const secretKey = Buffer.from(privateKeyBase64, "base64");
  if (secretKey.length !== 64) {
    throw new Error(
      "AVM private key must be a Base64-encoded 64-byte key (32-byte seed + 32-byte public key)",
    );
  }
  const seed = secretKey.subarray(0, 32);
  return ed25519Generator(seed);
}

/**
 * Creates a ClientAvmSigner from a Base64-encoded private key.
 *
 * This is the recommended way to create a client-side AVM signer for x402 payments.
 *
 * @param privateKeyBase64 - Base64-encoded 64-byte key (32-byte seed + 32-byte public key)
 * @returns A complete ClientAvmSigner ready for use with ExactAvmScheme
 *
 * @example
 * ```typescript
 * import { toClientAvmSigner } from "@x402/avm";
 * import { ExactAvmScheme } from "@x402/avm/exact/client";
 *
 * const signer = toClientAvmSigner(process.env.AVM_PRIVATE_KEY!);
 * client.register("algorand:*", new ExactAvmScheme(signer));
 * ```
 */
export function toClientAvmSigner(privateKeyBase64: string): ClientAvmSigner {
  const { ed25519Pubkey, rawEd25519Signer } = decodePrivateKey(privateKeyBase64);

  // Use algokit-utils generateAddressWithSigners for the canonical signer implementation
  const algokitSigners = generateAddressWithSigners({ ed25519Pubkey, rawEd25519Signer });
  const address = algokitSigners.addr.toString();

  const signer: ClientAvmSigner = {
    address,
    signTransactions: async (txns: Uint8Array[], indexesToSign?: number[]) => {
      return Promise.all(
        txns.map(async (txn, i) => {
          if (indexesToSign && !indexesToSign.includes(i)) return null;
          const decoded = decodeTransaction(txn);
          // Delegate to the algokit-utils signer (signs a single transaction in a group)
          const signedBytes = await algokitSigners.signer([decoded], [0]);
          return signedBytes[0];
        }),
      );
    },
  };

  // Attach the internal algokit-utils AddressWithSigners for use by internal code
  // (e.g., TransactionComposer integration in client scheme)
  Object.defineProperty(signer, ALGOKIT_SIGNER, {
    value: algokitSigners,
    enumerable: false,
    writable: false,
  });

  return signer;
}

/**
 * Extracts the internal algokit-utils AddressWithTransactionSigner from a ClientAvmSigner,
 * if available. Returns null for wallet-created signers that don't have an internal
 * algokit signer (e.g., signers created from browser wallet adapters).
 *
 * This is useful for internal code that needs to register the signer with
 * AlgorandClient or TransactionComposer.
 *
 * @param signer - A ClientAvmSigner instance
 * @returns The internal AddressWithTransactionSigner, or null if not available
 */
export function getAlgokitSigner(signer: ClientAvmSigner): AddressWithTransactionSigner | null {
  const internal = (signer as unknown as Record<symbol, unknown>)[ALGOKIT_SIGNER] as
    | AddressWithSigners
    | undefined;
  if (internal && "addr" in internal && "signer" in internal) {
    return { addr: internal.addr, signer: internal.signer };
  }
  return null;
}

/**
 * Determines if a network identifier refers to testnet.
 *
 * @param network - The network identifier (CAIP-2 format)
 * @returns True if the network is testnet
 */
function isTestnet(network: string): boolean {
  return network === ALGORAND_TESTNET_CAIP2;
}

/**
 * Creates a FacilitatorAvmSigner from a Base64-encoded private key.
 *
 * This is the recommended way to create a facilitator-side AVM signer for x402 payments.
 * Uses `AlgorandClient.testNet()` / `AlgorandClient.mainNet()` from AlgoKit Utils for
 * network connectivity, with optional URL overrides via config.
 *
 * @param privateKeyBase64 - Base64-encoded 64-byte key (32-byte seed + 32-byte public key)
 * @param config - Optional configuration for custom Algod URLs
 * @returns A complete FacilitatorAvmSigner ready for use with ExactAvmScheme
 *
 * @example
 * ```typescript
 * import { toFacilitatorAvmSigner } from "@x402/avm";
 * import { ExactAvmScheme } from "@x402/avm/exact/facilitator";
 *
 * // Default (AlgoNode endpoints):
 * const signer = toFacilitatorAvmSigner(process.env.AVM_PRIVATE_KEY!);
 *
 * // With custom URLs:
 * const signer = toFacilitatorAvmSigner(process.env.AVM_PRIVATE_KEY!, {
 *   testnetUrl: "https://my-testnet-node.example.com",
 *   mainnetUrl: "https://my-mainnet-node.example.com",
 * });
 *
 * facilitator.register("algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=", new ExactAvmScheme(signer));
 * ```
 */
export function toFacilitatorAvmSigner(
  privateKeyBase64: string,
  config?: FacilitatorAvmSignerConfig,
): FacilitatorAvmSigner {
  const { ed25519Pubkey, rawEd25519Signer } = decodePrivateKey(privateKeyBase64);

  // Use algokit-utils generateAddressWithSigners for the canonical signer implementation
  const algokitSigners = generateAddressWithSigners({ ed25519Pubkey, rawEd25519Signer });
  const address = algokitSigners.addr.toString();

  // Create AlgorandClient instances for each network, with optional URL overrides
  const getAlgorandClientForNetwork = (network: string) => {
    if (isTestnet(network)) {
      if (config?.testnetUrl) {
        return AlgorandClient.fromConfig({
          algodConfig: { server: config.testnetUrl, token: config.algodToken ?? "" },
        });
      }
      return AlgorandClient.testNet();
    }
    if (config?.mainnetUrl) {
      return AlgorandClient.fromConfig({
        algodConfig: { server: config.mainnetUrl, token: config.algodToken ?? "" },
      });
    }
    return AlgorandClient.mainNet();
  };

  // Cache AlgorandClient instances per network
  const clientCache = new Map<string, ReturnType<typeof AlgorandClient.testNet>>();

  const getClient = (network: string) => {
    const key = isTestnet(network) ? "testnet" : "mainnet";
    let client = clientCache.get(key);
    if (!client) {
      client = getAlgorandClientForNetwork(network);
      clientCache.set(key, client);
    }
    return client;
  };

  return {
    getAddresses: () => [address] as readonly string[],

    signTransaction: async (txn: Uint8Array, _: string) => {
      const decoded = decodeTransaction(txn);
      // Delegate to the algokit-utils signer
      const signedBytes = await algokitSigners.signer([decoded], [0]);
      return signedBytes[0];
    },

    getAlgodClient: (network: string) => getClient(network).client.algod,

    simulateTransactions: async (txns: Uint8Array[], network: string) => {
      const algod = getClient(network).client.algod;
      return await algod.simulateRawTransactions(txns);
    },

    sendTransactions: async (signedTxns: Uint8Array[], network: string) => {
      const algod = getClient(network).client.algod;
      const response = await algod.sendRawTransaction(signedTxns);
      return response.txId;
    },

    waitForConfirmation: async (txId: string, network: string, waitRounds: number = 5) => {
      const algod = getClient(network).client.algod;
      return await waitForConfirmation(txId, waitRounds, algod);
    },
  };
}
