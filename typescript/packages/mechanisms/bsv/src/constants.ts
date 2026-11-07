import type { Network } from "@x402/core/types";
import type { WalletProtocol } from "@bsv/sdk";

/**
 * CAIP-2 style network identifier for the BSV mainnet.
 *
 * Network names follow the registered ChainAgnostic `bsv` namespace
 * (ChainAgnostic/namespaces#190). The `bip122` namespace (genesis-block
 * reference) is ambiguous for BSV because BSV shares its genesis block with
 * BTC and BCH, so this implementation uses the dedicated `bsv` namespace.
 * Clients and facilitators MUST refuse ambiguous Bitcoin-family identifiers
 * (e.g. `bip122:000000000019d6689c085ae165831e93`) rather than defaulting them
 * to BSV.
 */
export const BSV_MAINNET_CAIP2: Network = "bsv:mainnet";

/** CAIP-2 style network identifier for the BSV public testnet */
export const BSV_TESTNET_CAIP2: Network = "bsv:testnet";

/** CAIP-2 style network identifier for Teranode Test Net (Teratestnet) */
export const BSV_TTN_CAIP2: Network = "bsv:ttn";

/** CAIP-2 style network identifier for Teranode Scaling Test Net */
export const BSV_TSTN_CAIP2: Network = "bsv:tstn";

/** Wildcard matching all BSV networks */
export const BSV_WILDCARD_CAIP2: Network = "bsv:*";

/**
 * Registered BSV CAIP-2 network identifiers (ChainAgnostic `bsv` namespace).
 * Order is stable for docs and iteration.
 */
export const BSV_NETWORKS: readonly Network[] = [
  BSV_MAINNET_CAIP2,
  BSV_TESTNET_CAIP2,
  BSV_TTN_CAIP2,
  BSV_TSTN_CAIP2,
] as const;

/**
 * Maps a registered BSV CAIP-2 identifier to the BRC-100 / wallet-layer
 * network name used by `getNetwork()`.
 */
export const BSV_CAIP2_TO_WALLET_NETWORK: ReadonlyMap<Network, string> = new Map([
  [BSV_MAINNET_CAIP2, "mainnet"],
  [BSV_TESTNET_CAIP2, "testnet"],
  [BSV_TTN_CAIP2, "ttn"],
  [BSV_TSTN_CAIP2, "tstn"],
]);

/** Native BSV satoshis use "BSV" as the asset identifier (ticker convention) */
export const BSV_ASSET_IDENTIFIER = "BSV";

/** Number of decimals for native BSV (1 BSV = 100,000,000 satoshis) */
export const BSV_DECIMALS = 8;

/** Maximum number of satoshis that can ever exist (21e14) */
export const MAX_SATOSHIS = 2_100_000_000_000_000;

/**
 * BRC-29 protocol ID used for BRC-42 payment key derivation.
 * Security level 2 with the BRC-29 magic number.
 */
export const BRC29_PROTOCOL_ID: WalletProtocol = [2, "3241645161d8"];

/**
 * Minimum number of bytes for the BRC-29 derivation prefix (the payment
 * nonce). BRC-121 mandates a fresh random prefix of at least 8 bytes.
 */
export const MIN_DERIVATION_PREFIX_BYTES = 8;

/**
 * Default payment freshness window in milliseconds (BRC-121: ±30 seconds).
 * The timestamp encoded in the payload's `derivationSuffix` must be within
 * this window of the verifier's clock.
 */
export const DEFAULT_PAYMENT_WINDOW_MS = 30_000;

/** Regex for a compressed secp256k1 public key (33 bytes hex, 02/03 prefix) */
export const COMPRESSED_PUBKEY_REGEX = /^0[23][0-9a-fA-F]{64}$/;

/** WhatsOnChain USD/BSV exchange-rate endpoint (mainnet) */
export const WOC_MAINNET_EXCHANGE_RATE_URL =
  "https://api.whatsonchain.com/v1/bsv/main/exchangerate";

/** WhatsOnChain USD/BSV exchange-rate endpoint (testnet) */
export const WOC_TESTNET_EXCHANGE_RATE_URL =
  "https://api.whatsonchain.com/v1/bsv/test/exchangerate";

/** Mainnet block explorer base URL */
export const BSV_MAINNET_EXPLORER = "https://whatsonchain.com";

/** Testnet block explorer base URL */
export const BSV_TESTNET_EXPLORER = "https://test.whatsonchain.com";

/** Teranode Test Net (ttn) block explorer base URL */
export const BSV_TTN_EXPLORER = "https://woc-ttn.bsvblockchain.tech";

/** Maps CAIP-2 identifiers to explorer base URLs (where a public explorer exists) */
export const BSV_NETWORK_TO_EXPLORER: ReadonlyMap<Network, string> = new Map([
  [BSV_MAINNET_CAIP2, BSV_MAINNET_EXPLORER],
  [BSV_TESTNET_CAIP2, BSV_TESTNET_EXPLORER],
  [BSV_TTN_CAIP2, BSV_TTN_EXPLORER],
  // tstn has no public block explorer; endpoints are deployment-private.
]);

/**
 * Checks whether a network identifier is a registered BSV CAIP-2 network.
 *
 * Does not accept `bip122:*` or other Bitcoin-family identifiers — those are
 * ambiguous for BSV and must be refused rather than defaulted.
 *
 * @param network - CAIP-2 network identifier
 * @returns True when the network is one of the registered `bsv:*` networks
 */
export function isBsvNetwork(network: Network): boolean {
  return BSV_CAIP2_TO_WALLET_NETWORK.has(network);
}

/**
 * Returns the BRC-100 wallet network name for a registered BSV CAIP-2 id.
 *
 * @param network - CAIP-2 network identifier
 * @returns Wallet `getNetwork()` value, or undefined if not a registered BSV network
 */
export function toBsvWalletNetwork(network: Network): string | undefined {
  return BSV_CAIP2_TO_WALLET_NETWORK.get(network);
}

/**
 * Gets the block explorer URL for a transaction.
 *
 * @param network - CAIP-2 network identifier
 * @param txid - Transaction id (hex)
 * @returns Full explorer URL, or undefined if network not recognized / no explorer
 */
export function getExplorerTxUrl(network: Network, txid: string): string | undefined {
  const base = BSV_NETWORK_TO_EXPLORER.get(network);
  return base ? `${base}/tx/${txid}` : undefined;
}
