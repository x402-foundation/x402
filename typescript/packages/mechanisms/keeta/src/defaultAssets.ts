import type {
  DefaultAsset,
  DefaultAssetTable,
  FindDefaultAsset,
  GetDefaultAsset,
} from "@x402/core/types";
import { KEETA_MAINNET_CAIP2, KEETA_TESTNET_CAIP2 } from "./constants";

export type KeetaDefaultAsset = DefaultAsset;

/** Keeta mainnet USDC (documented Circle-bridged token). */
export const USDC_MAINNET_ADDRESS =
  "keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna";

/** Keeta testnet USDC (documented Circle-bridged token). */
export const USDC_TESTNET_ADDRESS =
  "keeta_apna75yhhvnv4ei7ape55hndk4yepno7a7i2mhtiwahiygixjcnmvswxhnmnk";

const USDC_DECIMALS = 6;

/** Default USD-pegged assets by CAIP-2 network; index 0 is the `"$0.10"` default. */
export const DEFAULT_ASSETS: DefaultAssetTable<KeetaDefaultAsset> = {
  [KEETA_MAINNET_CAIP2]: [{ asset: USDC_MAINNET_ADDRESS, decimals: USDC_DECIMALS, symbol: "USDC" }],
  [KEETA_TESTNET_CAIP2]: [{ asset: USDC_TESTNET_ADDRESS, decimals: USDC_DECIMALS, symbol: "USDC" }],
};

/**
 * Look up a default asset by network and optional ticker.
 *
 * @param network - CAIP-2 network
 * @param symbol - Ticker; omit for the network default
 * @returns Matching entry
 * @throws If network or ticker is unknown
 */
export const getDefaultAsset: GetDefaultAsset<KeetaDefaultAsset> = (network, symbol?) => {
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
 * Reverse lookup by asset id and network.
 *
 * @param asset - Token address from payment requirements
 * @param network - CAIP-2 network
 * @returns Matching entry, or undefined
 */
export const findDefaultAsset: FindDefaultAsset<KeetaDefaultAsset> = (asset, network) => {
  const assets = DEFAULT_ASSETS[network];
  if (!assets) {
    return undefined;
  }
  return assets.find(entry => entry.asset === asset);
};
