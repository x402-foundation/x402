import type { Network } from "@x402/core/types";

/** CAIP-2 network identifier for Concordium Mainnet */
export const CONCORDIUM_MAINNET_CAIP2: Network = "ccd:9dd9ca4d19e9393877d2c44b70f89acb";

/** CAIP-2 network identifier for Concordium Testnet */
export const CONCORDIUM_TESTNET_CAIP2: Network = "ccd:4221332d34e1694168c2a0c0b3fd0f27";

/** Wildcard matching all Concordium networks */
export const CONCORDIUM_WILDCARD_CAIP2: Network = "ccd:*";

/** Default mainnet gRPC endpoint (host:port) */
export const CONCORDIUM_MAINNET_GRPC = "grpc.mainnet.concordium.software:20000";

/** Default testnet gRPC endpoint (host:port) */
export const CONCORDIUM_TESTNET_GRPC = "grpc.testnet.concordium.com:20000";

/** Default gRPC port */
export const DEFAULT_GRPC_PORT = 20000;

/** Mainnet block explorer base URL */
export const CONCORDIUM_MAINNET_EXPLORER = "https://ccdexplorer.io/mainnet";

/** Testnet block explorer base URL */
export const CONCORDIUM_TESTNET_EXPLORER = "https://ccdexplorer.io/testnet";

/**
 * Regex pattern for validating Concordium base58check account addresses.
 * Matches 45–55 alphanumeric characters (base58 alphabet, no 0/O/I/l).
 */
export const CONCORDIUM_ADDRESS_REGEX =
  /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{45,55}$/;

/** Default decimals for native CCD */
export const CCD_DECIMALS = 6;

/** Native CCD uses "CCD" as asset identifier (Concordium-specific convention) */
export const CCD_ASSET_IDENTIFIER = "CCD";

/**
 * Maximum allowed transaction expiry offset in seconds (spec Rule 7).
 * Transactions with expiry > now + this value are rejected.
 */
export const MAX_EXPIRY_OFFSET_SECONDS = 600;

/**
 * Default timeout for waiting for ConcordiumBFT finalization (ms).
 * Concordium has ~10s deterministic finality; 60s provides comfortable margin.
 */
export const DEFAULT_FINALIZATION_TIMEOUT_MS = 60_000;

/** Maps CAIP-2 identifiers to gRPC endpoints */
export const CONCORDIUM_NETWORK_TO_GRPC: ReadonlyMap<Network, string> = new Map([
  [CONCORDIUM_MAINNET_CAIP2, CONCORDIUM_MAINNET_GRPC],
  [CONCORDIUM_TESTNET_CAIP2, CONCORDIUM_TESTNET_GRPC],
]);

/** Maps CAIP-2 identifiers to explorer base URLs */
export const CONCORDIUM_NETWORK_TO_EXPLORER: ReadonlyMap<Network, string> = new Map([
  [CONCORDIUM_MAINNET_CAIP2, CONCORDIUM_MAINNET_EXPLORER],
  [CONCORDIUM_TESTNET_CAIP2, CONCORDIUM_TESTNET_EXPLORER],
]);

/**
 * Gets the gRPC endpoint for a Concordium network.
 *
 * @param network - CAIP-2 network identifier
 * @returns gRPC endpoint string (host:port)
 * @throws If the network is not recognized
 */
export function getConcordiumGrpcUrl(network: Network): string {
  const url = CONCORDIUM_NETWORK_TO_GRPC.get(network);
  if (!url) {
    throw new Error(`Unsupported Concordium network: "${network}"`);
  }
  return url;
}

/**
 * Gets the block explorer URL for a transaction.
 *
 * @param network - CAIP-2 network identifier
 * @param txHash - Transaction hash (hex)
 * @returns Full explorer URL, or undefined if network not recognized
 */
export function getExplorerTxUrl(network: Network, txHash: string): string | undefined {
  const base = CONCORDIUM_NETWORK_TO_EXPLORER.get(network);
  return base ? `${base}/transaction/${txHash}` : undefined;
}

/**
 * Gets the block explorer URL for an account.
 *
 * @param network - CAIP-2 network identifier
 * @param address - Account address (base58check)
 * @returns Full explorer URL, or undefined if network not recognized
 */
export function getExplorerAccountUrl(network: Network, address: string): string | undefined {
  const base = CONCORDIUM_NETWORK_TO_EXPLORER.get(network);
  return base ? `${base}/account/${address}` : undefined;
}

/**
 * Parses a gRPC endpoint string into host and port.
 *
 * @param grpcUrl - Endpoint in "host:port" format
 * @returns Tuple of [host, port]
 */
export function parseGrpcUrl(grpcUrl: string): [host: string, port: number] {
  const [host, portStr] = grpcUrl.split(":");
  return [host, parseInt(portStr, 10) || DEFAULT_GRPC_PORT];
}
