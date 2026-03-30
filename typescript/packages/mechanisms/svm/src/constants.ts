/**
 * Token program addresses for SPL Token and Token-2022
 * These addresses are the same across all Solana networks (mainnet, devnet, testnet)
 */
export const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const COMPUTE_BUDGET_PROGRAM_ADDRESS = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * Phantom/Solflare Lighthouse program address
 * Phantom and Solflare wallets inject Lighthouse instructions for user protection on mainnet transactions.
 * - Phantom adds 1 Lighthouse instruction (4th instruction)
 * - Solflare adds 2 Lighthouse instructions (4th and 5th instructions)
 * We allow these as optional instructions to support these wallets.
 * See: https://github.com/coinbase/x402/issues/828
 */
export const LIGHTHOUSE_PROGRAM_ADDRESS = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

/**
 * Default RPC URLs for Solana networks
 */
export const DEVNET_RPC_URL = "https://api.devnet.solana.com";
export const TESTNET_RPC_URL = "https://api.testnet.solana.com";
export const MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com";
export const DEVNET_WS_URL = "wss://api.devnet.solana.com";
export const TESTNET_WS_URL = "wss://api.testnet.solana.com";
export const MAINNET_WS_URL = "wss://api.mainnet-beta.solana.com";

/**
 * USDC token mint addresses (default stablecoin)
 */
export const USDC_MAINNET_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DEVNET_ADDRESS = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const USDC_TESTNET_ADDRESS = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // Same as devnet

/**
 * Compute budget configuration
 * All prices are in microlamports (1 lamport = 1,000,000 microlamports)
 */
export const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1;
export const MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 5_000_000; // 5 lamports
export const DEFAULT_COMPUTE_UNIT_LIMIT = 20_000;

/**
 * How long a transaction is held in the duplicate settlement cache (ms).
 * Covers the Solana blockhash lifetime (~60-90s) with margin.
 */
export const SETTLEMENT_TTL_MS = 120_000;

/**
 * Solana address validation regex (base58, 32-44 characters)
 */
export const SVM_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * CAIP-2 network identifiers for Solana (V2)
 */
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SOLANA_TESTNET_CAIP2 = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";

/**
 * V1 to V2 network identifier mappings (for backwards compatibility)
 * V1 used simple names like solana, V2 uses CAIP-2
 */
export const V1_TO_V2_NETWORK_MAP: Record<string, string> = {
  solana: SOLANA_MAINNET_CAIP2,
  "solana-devnet": SOLANA_DEVNET_CAIP2,
  "solana-testnet": SOLANA_TESTNET_CAIP2,
};
