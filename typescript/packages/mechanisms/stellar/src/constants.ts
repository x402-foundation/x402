/**
 * CAIP-2 network identifiers for Stellar (V2)
 */
export const STELLAR_PUBNET_CAIP2 = "stellar:pubnet";
export const STELLAR_TESTNET_CAIP2 = "stellar:testnet";
export const STELLAR_WILDCARD_CAIP2 = "stellar:*";

/**
 * Default testnet RPC URL
 */
export const DEFAULT_TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";

/**
 * Default Horizon API URLs
 */
export const DEFAULT_TESTNET_HORIZON_URL = "https://horizon-testnet.stellar.org";
export const DEFAULT_PUBNET_HORIZON_URL = "https://horizon.stellar.org";

/**
 * Stellar validation regex for destination and asset addresses
 */
export const STELLAR_DESTINATION_ADDRESS_REGEX = /^(?:[GC][ABCD][A-Z2-7]{54}|M[ABCD][A-Z2-7]{67})$/; // Stellar address: G-account (56 chars), C-account (56 chars), or M-account (69 chars, muxed)
export const STELLAR_ASSET_ADDRESS_REGEX = /^(?:[C][ABCD][A-Z2-7]{54})$/; // Stellar token contract address: C-account (56 chars)

/**
 * USDC contract addresses (default stablecoin)
 */
export const USDC_PUBNET_ADDRESS = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
export const USDC_TESTNET_ADDRESS = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

export const STELLAR_NETWORK_TO_PASSPHRASE: ReadonlyMap<string, string> = new Map([
  [STELLAR_PUBNET_CAIP2, "Public Global Stellar Network ; September 2015"],
  [STELLAR_TESTNET_CAIP2, "Test SDF Network ; September 2015"],
]);

/**
 * Default token decimals
 */
export const DEFAULT_TOKEN_DECIMALS = 7;
