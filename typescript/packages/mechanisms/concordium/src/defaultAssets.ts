import type {
  DefaultAsset,
  DefaultAssetTable,
  FindDefaultAsset,
  GetDefaultAsset,
} from "@x402/core/types";
import { CONCORDIUM_MAINNET_CAIP2, CONCORDIUM_TESTNET_CAIP2 } from "./constants";

export type ConcordiumDefaultAsset = DefaultAsset;

/** StablR USDR protocol-level token id (same symbol on mainnet and testnet). */
export const USDR_TOKEN_ID = "USDR";

const USDR_DECIMALS = 6;

/** Default USD-pegged assets by CAIP-2 network; index 0 is the `"$0.10"` default. */
export const DEFAULT_ASSETS: DefaultAssetTable<ConcordiumDefaultAsset> = {
  [CONCORDIUM_MAINNET_CAIP2]: [{ asset: USDR_TOKEN_ID, decimals: USDR_DECIMALS, symbol: "USDR" }],
  [CONCORDIUM_TESTNET_CAIP2]: [{ asset: USDR_TOKEN_ID, decimals: USDR_DECIMALS, symbol: "USDR" }],
};

/**
 * Look up a default asset by network and optional ticker.
 *
 * @param network - CAIP-2 network
 * @param symbol - Ticker; omit for the network default
 * @returns Matching entry
 * @throws If network or ticker is unknown
 */
export const getDefaultAsset: GetDefaultAsset<ConcordiumDefaultAsset> = (network, symbol?) => {
  const assets = DEFAULT_ASSETS[network];
  if (!assets || assets.length === 0) {
    throw new Error(`No default asset configured for network ${network}`);
  }
  if (!symbol) {
    return assets[0];
  }
  const normalized = symbol.toUpperCase();
  const match = assets.find(entry => entry.symbol.toUpperCase() === normalized);
  if (!match) {
    throw new Error(`No ${symbol} default asset configured for network ${network}`);
  }
  return match;
};

/**
 * Reverse lookup by PLT token id and network.
 *
 * @param asset - Token id from payment requirements (e.g. `"USDR"`)
 * @param network - CAIP-2 network
 * @returns Matching entry, or undefined
 */
export const findDefaultAsset: FindDefaultAsset<ConcordiumDefaultAsset> = (asset, network) => {
  const assets = DEFAULT_ASSETS[network];
  if (!assets) {
    return undefined;
  }
  const normalized = asset.toUpperCase();
  return assets.find(entry => entry.asset.toUpperCase() === normalized);
};
