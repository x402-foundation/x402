import type {
  TransactionSigner,
  MessagePartialSigner,
  RpcDevnet,
  SolanaRpcApiDevnet,
  RpcTestnet,
  SolanaRpcApiTestnet,
  RpcMainnet,
  SolanaRpcApiMainnet,
  Address,
} from "@solana/kit";
import { fetchAddressesForLookupTables, getBase64EncodedWireTransaction } from "@solana/kit";
import {
  createRpcClient,
  decodeTransactionFromPayload,
  TransactionOnchainFailureError,
} from "./utils";
import { ErrSmartWalletAltResolutionFailed } from "./exact/facilitator/errors";

/**
 * Client-side signer for creating and signing Solana transactions
 * This is a wrapper around TransactionSigner from @solana/kit
 */
export type ClientSvmSigner = TransactionSigner;

/**
 * Configuration for client operations
 */
export type ClientSvmConfig = {
  /**
   * Optional custom RPC URL for the client to use
   */
  rpcUrl?: string;
};

/**
 * Signing capabilities needed by the facilitator
 * Must support both transaction and message signing
 * KeyPairSigner from @solana/kit satisfies this interface
 */
export type FacilitatorSigningCapabilities = TransactionSigner & MessagePartialSigner;

/**
 * RPC client type from @solana/kit
 * Can be devnet, testnet, or mainnet RPC client
 */
export type FacilitatorRpcClient =
  | RpcDevnet<SolanaRpcApiDevnet>
  | RpcTestnet<SolanaRpcApiTestnet>
  | RpcMainnet<SolanaRpcApiMainnet>;

/**
 * RPC capabilities needed by the facilitator for verification and settlement
 * This is a legacy interface for custom RPC implementations
 */
export type FacilitatorRpcCapabilities = {
  /**
   * Get the SOL balance of an account
   *
   * @param address - Base58 encoded address
   * @returns Balance in lamports
   */
  getBalance(address: string): Promise<bigint>;

  /**
   * Get the token account balance
   *
   * @param address - Base58 encoded token account address
   * @returns Token balance in smallest units
   */
  getTokenAccountBalance(address: string): Promise<bigint>;

  /**
   * Get the latest blockhash information
   *
   * @returns Blockhash and last valid block height
   */
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;

  /**
   * Simulate a transaction to check if it would succeed
   *
   * @param transaction - Base64 encoded transaction
   * @param config - Simulation configuration
   * @returns Simulation result
   */
  simulateTransaction(transaction: string, config: unknown): Promise<unknown>;

  /**
   * Send a transaction to the network
   *
   * @param transaction - Base64 encoded signed transaction
   * @returns Transaction signature
   */
  sendTransaction(transaction: string): Promise<string>;

  /**
   * Wait for transaction confirmation
   *
   * @param signature - Transaction signature
   * @returns Confirmation result
   */
  confirmTransaction(signature: string): Promise<unknown>;

  /**
   * Fetch token mint information
   *
   * @param address - Base58 encoded mint address
   * @returns Mint information including decimals
   */
  fetchMint(address: string): Promise<unknown>;
};

/** Options passed to {@link FacilitatorSvmSigner.simulateTransaction}. */
export type FacilitatorSimulateTransactionOptions = {
  /**
   * When true, the RPC verifies signatures during simulation. Defaults to false
   * because the fee-payer slot is often unsigned until settle.
   */
  sigVerify?: boolean;
  /**
   * When true, the RPC substitutes a fresh blockhash before simulating (for
   * facilitator-built messages compiled against a placeholder). Defaults to false.
   */
  replaceRecentBlockhash?: boolean;
  /** Simulation commitment. Defaults to `"confirmed"`. */
  commitment?: string;
  /** Wire encoding of the transaction. Defaults to `"base64"`. */
  encoding?: string;
};

/**
 * Minimal facilitator signer interface for SVM operations.
 * Supports multiple signers for load balancing and high availability.
 * All implementation details (RPC clients, key management, signature handling) are hidden.
 */
export type FacilitatorSvmSigner = {
  /**
   * Get all addresses this facilitator can use as fee payers
   * Enables dynamic address selection for load balancing and key rotation
   *
   * @returns Array of addresses available for signing
   */
  getAddresses(): readonly Address[];

  /**
   * Resolve the kit-native signer for a fee-payer address.
   * Required by schemes that build transactions from instructions (e.g. upto);
   * wire-level schemes such as exact omit this.
   *
   * @param feePayer - Fee payer address
   * @returns Kit TransactionSigner & MessagePartialSigner for that address
   * @throws Error if no signer exists for feePayer
   */
  getSigner?(feePayer: Address): FacilitatorSigningCapabilities;

  /**
   * Sign a partially-signed transaction with the signer matching feePayer
   * Transaction is decoded, signed, and re-encoded internally
   *
   * @param transaction - Base64 encoded partially-signed transaction
   * @param feePayer - Fee payer address (determines which signer to use)
   * @param network - CAIP-2 network identifier
   * @returns Base64 encoded fully-signed transaction
   * @throws Error if no signer exists for feePayer or signing fails
   */
  signTransaction(transaction: string, feePayer: Address, network: string): Promise<string>;

  /**
   * Simulate a transaction to verify it would succeed onchain.
   * By default does not verify signatures (RPC `sigVerify` is off). Callers must
   * verify required signatures themselves; the fee-payer slot may be unsigned.
   *
   * @param transaction - Base64 encoded transaction (may be partially signed)
   * @param network - CAIP-2 network identifier
   * @param options - Optional simulation overrides
   * @throws Error if simulation fails
   */
  simulateTransaction(
    transaction: string,
    network: string,
    options?: FacilitatorSimulateTransactionOptions,
  ): Promise<void>;

  /**
   * Send a signed transaction to the network
   * Implementation manages RPC client selection and sending details
   *
   * @param transaction - Base64 encoded signed transaction
   * @param network - CAIP-2 network identifier
   * @returns Transaction signature
   * @throws Error if send fails
   */
  sendTransaction(transaction: string, network: string): Promise<string>;

  /**
   * Wait for transaction confirmation
   * Allows signer to implement custom retry logic, timeouts, and confirmation strategies
   *
   * @param signature - Transaction signature to confirm
   * @param network - CAIP-2 network identifier
   * @returns Promise that resolves when transaction is confirmed
   * @throws {TransactionOnchainFailureError} If the transaction reached the chain and failed
   *   there (terminal — safe to release dedup/pending-settlement locks)
   * @throws Error for any other confirmation failure, e.g. a wait timeout (non-terminal —
   *   the outcome is unknown, so callers must not treat it as a definite failure)
   */
  confirmTransaction(signature: string, network: string): Promise<void>;

  /**
   * Simulate a transaction and return inner instructions (CPI calls).
   * Used by smart wallet verification to find TransferChecked instructions
   * executed via CPI by smart wallet programs (Squads, Swig, etc.).
   *
   * Optional — if not implemented, smart wallet verification is unavailable.
   * The default toFacilitatorSvmSigner() factory provides an implementation.
   *
   * @param transaction - Base64 encoded transaction (may be partially signed)
   * @param network - CAIP-2 network identifier
   * @returns Inner instructions from simulation, or null if unavailable
   * @throws Error if simulation fails (transaction would revert on-chain)
   */
  simulateTransactionWithInnerInstructions?(
    transaction: string,
    network: string,
  ): Promise<SvmInnerInstructionsResult>;

  /**
   * Fetch inner instructions from a confirmed transaction.
   * Used for post-settlement verification to confirm that the TransferChecked
   * actually executed on-chain (defends against TOCTOU in simulation path).
   *
   * Optional — if not implemented, post-settlement verification falls back
   * to balance-delta checking only.
   *
   * @param signature - Transaction signature to fetch
   * @param network - CAIP-2 network identifier
   * @returns Inner instructions from the confirmed transaction, or null if not yet indexed
   */
  getConfirmedTransactionInnerInstructions?(
    signature: string,
    network: string,
  ): Promise<SvmInnerInstructionsResult | null>;

  /**
   * Get the token balance of a specific token account.
   * Used for balance-delta fallback in post-settlement verification.
   *
   * Optional — if not implemented, balance-delta fallback is unavailable.
   *
   * @param tokenAccountAddress - Base58 encoded token account (ATA) address
   * @param network - CAIP-2 network identifier
   * @returns Token balance in atomic units, or null if account not found
   */
  getTokenAccountBalance?(tokenAccountAddress: string, network: string): Promise<bigint | null>;

  /**
   * Resolve Address Lookup Tables for v0 transactions.
   * Returns a map of ALT address to resolved account address arrays.
   * Used by fee payer isolation check to inspect ALT-resolved accounts.
   *
   * Optional — if not implemented, transactions with ALTs are rejected
   * conservatively (safe, but limits smart wallet coverage for wallets
   * that use ALTs like Crossmint/Swig).
   *
   * @param lookupTableAddresses - Base58 encoded ALT addresses to resolve
   * @param network - CAIP-2 network identifier
   * @returns Map of ALT address to ordered array of resolved account addresses
   */
  fetchAddressLookupTables?(
    lookupTableAddresses: string[],
    network: string,
  ): Promise<Record<string, string[]>>;

  /**
   * Fetch one account's onchain data. Optional — required by the `upto` scheme;
   * {@link toFacilitatorSvmSigner} provides an implementation.
   */
  getAccountInfo?(
    accountAddress: string,
    network: string,
    options?: { commitment?: string; encoding?: string },
  ): Promise<FacilitatorAccountInfo | null>;

  /**
   * Fetch a recent blockhash. Optional — required by the `upto` scheme;
   * {@link toFacilitatorSvmSigner} provides an implementation.
   */
  getLatestBlockhash?(network: string): Promise<{
    blockhash: string;
    lastValidBlockHeight: bigint;
  }>;

  /**
   * Fetch the current slot. Optional — required by the `upto` scheme;
   * {@link toFacilitatorSvmSigner} provides an implementation.
   */
  getSlot?(network: string, commitment?: string): Promise<bigint>;

  /**
   * Scan program accounts. Optional — required only for `upto` rent-cleanup
   * discovery sweeps; {@link toFacilitatorSvmSigner} provides an implementation.
   */
  getProgramAccounts?(
    network: string,
    programId: string,
    config: {
      commitment?: string;
      encoding?: string;
      filters?: readonly unknown[];
    },
  ): Promise<readonly FacilitatorProgramAccount[]>;
};

/** Account info returned by {@link FacilitatorSvmSigner.getAccountInfo}. */
export type FacilitatorAccountInfo = {
  data: [string, string] | string;
  owner: string;
  lamports: bigint;
};

/** One row from {@link FacilitatorSvmSigner.getProgramAccounts}. */
export type FacilitatorProgramAccount = {
  pubkey: Address;
  account: {
    data: [string, string];
    owner: Address;
  };
};

/**
 * Result from simulation with inner instruction inspection.
 */
export type SvmInnerInstructionsResult = {
  innerInstructions: Array<{
    index: number;
    instructions: Array<{
      programIdIndex: number;
      accounts: number[];
      data: string;
    }>;
  }> | null;
};

/**
 * Convert a signer to ClientSvmSigner (identity function for type safety)
 *
 * @param signer - The signer to convert
 * @returns The signer as ClientSvmSigner
 */
export function toClientSvmSigner(signer: ClientSvmSigner): ClientSvmSigner {
  return signer;
}

/**
 * Create RPC capabilities from a Solana Kit RPC client
 *
 * @param rpc - The RPC client from @solana/kit
 * @returns RPC capabilities for the facilitator
 */
export function createRpcCapabilitiesFromRpc(
  rpc: FacilitatorRpcClient,
): FacilitatorRpcCapabilities {
  return {
    getBalance: async address => {
      const result = await rpc.getBalance(address as never).send();
      return result.value;
    },
    getTokenAccountBalance: async address => {
      const accountInfo = await rpc
        .getAccountInfo(address as never, {
          encoding: "jsonParsed",
        })
        .send();

      if (!accountInfo.value) {
        throw new Error(`Token account not found: ${address}`);
      }

      const parsed = accountInfo.value.data as {
        parsed: { info: { tokenAmount: { amount: string } } };
      };
      return BigInt(parsed.parsed.info.tokenAmount.amount);
    },
    getLatestBlockhash: async () => {
      const result = await rpc.getLatestBlockhash().send();
      return {
        blockhash: result.value.blockhash,
        lastValidBlockHeight: result.value.lastValidBlockHeight,
      };
    },
    simulateTransaction: async (transaction, config) => {
      return await rpc.simulateTransaction(transaction as never, config as never).send();
    },
    sendTransaction: async transaction => {
      return await rpc
        .sendTransaction(transaction as never, {
          encoding: "base64",
          skipPreflight: true,
          preflightCommitment: "confirmed",
        })
        .send();
    },
    confirmTransaction: async signature => {
      // Poll at 250ms for the first ~2s (Solana slots are ~400ms), then 1s,
      // keeping the same ~30s confirmation budget as the previous 30×1s loop.
      const initialDelayMs = 250;
      const initialWindowMs = 2_000;
      const fallbackDelayMs = 1_000;
      const maxWaitMs = 30_000;
      const startedAt = Date.now();

      while (Date.now() - startedAt < maxWaitMs) {
        const status = await rpc.getSignatureStatuses([signature as never]).send();
        const entry = status.value[0];

        if (
          entry?.confirmationStatus === "confirmed" ||
          entry?.confirmationStatus === "finalized"
        ) {
          if (entry.err) {
            const errorStr = JSON.stringify(entry.err, (_, v) =>
              typeof v === "bigint" ? v.toString() : v,
            );
            throw new TransactionOnchainFailureError(`Transaction failed onchain: ${errorStr}`);
          }
          return entry;
        }

        const elapsed = Date.now() - startedAt;
        const delay = elapsed < initialWindowMs ? initialDelayMs : fallbackDelayMs;
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      throw new Error("Transaction confirmation timeout");
    },
    fetchMint: async address => {
      const { fetchMint } = await import("@solana-program/token-2022");
      return await fetchMint(rpc, address as never);
    },
  };
}

/**
 * RPC configuration for the facilitator
 * Can be a single RPC (all networks), a network mapping, or config options
 */
export type FacilitatorRpcConfig =
  | FacilitatorRpcClient // Single RPC for all networks
  | Record<string, FacilitatorRpcClient> // Per-network RPC mapping
  | { defaultRpcUrl?: string }; // Custom default RPC URL

/**
 * Create a FacilitatorSvmSigner from a TransactionSigner and optional RPC config
 *
 * @param signer - The TransactionSigner (e.g., from createKeyPairSignerFromBytes)
 * @param rpcConfig - Optional RPC configuration (single RPC, per-network map, or config)
 * @returns A complete FacilitatorSvmSigner
 *
 * @example
 * ```ts
 * import { createKeyPairSignerFromBytes, createSolanaRpc, devnet } from "@solana/kit";
 *
 * // Option 1: No RPC - use defaults (SIMPLEST)
 * const keypair = await createKeyPairSignerFromBytes(privateKeyBytes);
 * const facilitator = toFacilitatorSvmSigner(keypair);
 *
 * // Option 2: Single RPC for all networks
 * const rpc = createSolanaRpc(devnet("https://api.devnet.solana.com"));
 * const facilitator = toFacilitatorSvmSigner(keypair, rpc);
 *
 * // Option 3: Per-network RPC (FLEXIBLE)
 * const facilitator = toFacilitatorSvmSigner(keypair, {
 *   [SOLANA_MAINNET_CAIP2]: myQuickNodeRpc,
 *   // Devnet/testnet use defaults
 * });
 *
 * // Option 4: Custom default RPC URL
 * const facilitator = toFacilitatorSvmSigner(keypair, {
 *   defaultRpcUrl: "https://my-rpc.com"
 * });
 * ```
 */
export function toFacilitatorSvmSigner(
  signer: TransactionSigner & MessagePartialSigner,
  rpcConfig?: FacilitatorRpcConfig,
): FacilitatorSvmSigner {
  let rpcMap: Record<string, FacilitatorRpcClient> = {};
  let defaultRpcUrl: string | undefined;

  if (rpcConfig) {
    // Check if it's a config object with defaultRpcUrl
    if ("defaultRpcUrl" in rpcConfig && typeof rpcConfig.defaultRpcUrl === "string") {
      defaultRpcUrl = rpcConfig.defaultRpcUrl;
    }
    // Check if it's a single RPC client
    else if ("getBalance" in rpcConfig || "getSlot" in rpcConfig) {
      rpcMap["*"] = rpcConfig as FacilitatorRpcClient;
    }
    // Otherwise, it's a network mapping
    else {
      rpcMap = rpcConfig as Record<string, FacilitatorRpcClient>;
    }
  }

  const getRpcForNetwork = (network: string): FacilitatorRpcClient => {
    // 1. Check for exact network match
    if (rpcMap[network]) {
      return rpcMap[network];
    }

    // 2. Check for wildcard RPC
    if (rpcMap["*"]) {
      return rpcMap["*"];
    }

    // 3. Create default RPC for this network
    return createRpcClient(network as `${string}:${string}`, defaultRpcUrl);
  };

  return {
    getAddresses: () => {
      return [signer.address];
    },

    getSigner: (feePayer: Address) => {
      if (feePayer !== signer.address) {
        throw new Error(`No signer for feePayer ${feePayer}. Available: ${signer.address}`);
      }
      return signer;
    },

    signTransaction: async (transaction: string, feePayer: Address, _: string) => {
      if (feePayer !== signer.address) {
        throw new Error(`No signer for feePayer ${feePayer}. Available: ${signer.address}`);
      }

      // Decode transaction from base64
      const tx = decodeTransactionFromPayload({ transaction });

      // Sign the transaction
      const signableMessage = {
        content: tx.messageBytes,
        signatures: tx.signatures,
      };

      const [facilitatorSignatureDictionary] = await signer.signMessages([
        signableMessage as never,
      ]);

      // Merge signatures and encode
      const fullySignedTx = {
        ...tx,
        signatures: {
          ...tx.signatures,
          ...facilitatorSignatureDictionary,
        },
      };

      return getBase64EncodedWireTransaction(fullySignedTx);
    },

    simulateTransaction: async (
      transaction: string,
      network: string,
      options?: FacilitatorSimulateTransactionOptions,
    ) => {
      const rpc = getRpcForNetwork(network);
      const result = await rpc
        .simulateTransaction(
          transaction as never,
          {
            sigVerify: options?.sigVerify ?? false,
            replaceRecentBlockhash: options?.replaceRecentBlockhash ?? false,
            commitment: options?.commitment ?? "confirmed",
            encoding: options?.encoding ?? "base64",
          } as never,
        )
        .send();

      if (result.value.err) {
        // Use replacer to handle BigInt values from Solana RPC responses
        const errorStr = JSON.stringify(result.value.err, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        );
        throw new Error(`Simulation failed: ${errorStr}`);
      }
    },

    sendTransaction: async (transaction: string, network: string) => {
      const rpc = getRpcForNetwork(network);
      return await rpc
        .sendTransaction(transaction as never, {
          encoding: "base64",
          skipPreflight: true,
          preflightCommitment: "confirmed",
        })
        .send();
    },

    confirmTransaction: async (signature: string, network: string) => {
      const rpc = getRpcForNetwork(network);
      const rpcCapabilities = createRpcCapabilitiesFromRpc(rpc);
      await rpcCapabilities.confirmTransaction(signature);
    },

    simulateTransactionWithInnerInstructions: async (transaction: string, network: string) => {
      // Signature and blockhash verification during simulation.
      //
      // sigVerify: false — required signatures are verified locally before this
      // call. The fee-payer slot is unsigned until settle, so RPC-side
      // sigVerify would reject a valid payment. Account state, fee-payer
      // balance, and precompiles are still evaluated by simulation.
      //
      // replaceRecentBlockhash: false — preserves the original blockhash so signatures
      // remain valid (they cover the full message including blockhash). Also required for
      // durable nonce transactions (AdvanceNonceAccount), which use a nonce instead of a
      // recent blockhash and are valid indefinitely until the nonce is advanced.
      // See RFC #646 for the durable nonce handling specification.
      //
      // Blockhash expiry (~60-90s) is not a concern: the x402 flow (payer signs → HTTP
      // request → facilitator verifies) completes well within this window. If the
      // blockhash has expired, the transaction can't land on-chain regardless, so
      // rejecting at verify-time is the correct behavior.
      const rpc = getRpcForNetwork(network);
      const result = await rpc
        .simulateTransaction(
          transaction as never,
          {
            sigVerify: false,
            replaceRecentBlockhash: false,
            commitment: "confirmed",
            encoding: "base64",
            innerInstructions: true,
          } as never,
        )
        .send();

      const value = result.value as unknown as {
        err: unknown;
        innerInstructions?: Array<{
          index: number;
          instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }>;
        }>;
      };

      if (value.err) {
        const errorStr = JSON.stringify(value.err, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        );
        throw new Error(`Smart wallet simulation failed: ${errorStr}`);
      }

      return { innerInstructions: value.innerInstructions ?? null };
    },

    getConfirmedTransactionInnerInstructions: async (
      signature: string,
      network: string,
    ): Promise<SvmInnerInstructionsResult | null> => {
      const rpc = getRpcForNetwork(network);
      const result = await rpc
        .getTransaction(
          signature as never,
          {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
            encoding: "jsonParsed",
          } as never,
        )
        .send();

      if (!result) {
        return null;
      }

      const meta = (
        result as unknown as {
          meta?: { innerInstructions?: SvmInnerInstructionsResult["innerInstructions"] };
        }
      ).meta;
      return { innerInstructions: meta?.innerInstructions ?? null };
    },

    getTokenAccountBalance: async (
      tokenAccountAddress: string,
      network: string,
    ): Promise<bigint | null> => {
      const rpc = getRpcForNetwork(network);
      try {
        const result = await rpc
          .getTokenAccountBalance(
            tokenAccountAddress as never,
            { commitment: "confirmed" } as never,
          )
          .send();
        const amount = (result as unknown as { value?: { amount?: string } }).value?.amount;
        return amount ? BigInt(amount) : null;
      } catch {
        return null;
      }
    },

    fetchAddressLookupTables: async (
      lookupTableAddresses: string[],
      network: string,
    ): Promise<Record<string, string[]>> => {
      const rpc = getRpcForNetwork(network);
      try {
        const resolved = await fetchAddressesForLookupTables(
          lookupTableAddresses.map(a => a as Address),
          rpc,
        );
        const result: Record<string, string[]> = {};
        for (const [key, addresses] of Object.entries(resolved)) {
          result[key] = addresses.map((a: Address) => a.toString());
        }
        return result;
      } catch (error) {
        // Surface resolution failures rather than returning an empty map.
        // An empty map would be indistinguishable from "no ALTs", silently
        // weakening the fee-payer isolation check that depends on resolved
        // accounts. The caller (assertFeePayerIsolated) converts this into a
        // verify failure so a transient RPC blip fails the payment safely.
        throw new Error(
          `${ErrSmartWalletAltResolutionFailed}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    getAccountInfo: async (accountAddress, network, options) => {
      const rpc = getRpcForNetwork(network);
      const result = await rpc
        .getAccountInfo(accountAddress as never, {
          commitment: (options?.commitment ?? "confirmed") as never,
          encoding: (options?.encoding ?? "base64") as never,
        })
        .send();
      const value = result.value as FacilitatorAccountInfo | null;
      return value;
    },

    getLatestBlockhash: async (network: string) => {
      const rpc = getRpcForNetwork(network);
      const result = await rpc.getLatestBlockhash({ commitment: "finalized" }).send();
      return {
        blockhash: result.value.blockhash,
        lastValidBlockHeight: result.value.lastValidBlockHeight,
      };
    },

    getSlot: async (network: string, commitment = "finalized") => {
      const rpc = getRpcForNetwork(network);
      return await rpc.getSlot({ commitment: commitment as never }).send();
    },

    getProgramAccounts: async (network, programId, config) => {
      const rpc = getRpcForNetwork(network);
      return await rpc
        .getProgramAccounts(programId as Address, {
          commitment: (config.commitment ?? "confirmed") as never,
          encoding: "base64",
          filters: config.filters as never,
        })
        .send();
    },
  };
}
