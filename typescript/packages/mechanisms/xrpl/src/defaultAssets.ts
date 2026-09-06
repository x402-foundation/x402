import type {
  DefaultAsset,
  DefaultAssetTable,
  FindDefaultAsset,
  GetDefaultAsset,
} from "@x402/core/types";
import { XRPL_MAINNET, XRPL_TESTNET } from "./constants";

/**
 * Ripple RLUSD as an XRPL issued currency. Token identity is `(currency, issuer)`;
 * `asset` is the 160-bit currency hex and `issuer` is copied into payment-requirements extra.
 */
export type XrplDefaultAsset = DefaultAsset & {
  /** IOU issuer classic address. Required for RLUSD. */
  issuer: string;
};

/** RLUSD currency as 160-bit hex (ASCII "RLUSD" padded). */
export const RLUSD_CURRENCY = "524C555344000000000000000000000000000000";

/** Official Ripple RLUSD issuer on XRPL mainnet. */
export const RLUSD_MAINNET_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

/** Official Ripple RLUSD issuer on XRPL testnet. */
export const RLUSD_TESTNET_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

/** Default USD-pegged assets by CAIP-2 network; index 0 is the `"$0.10"` default. */
export const DEFAULT_ASSETS: DefaultAssetTable<XrplDefaultAsset> = {
  [XRPL_MAINNET]: [
    {
      asset: RLUSD_CURRENCY,
      decimals: 15,
      symbol: "RLUSD",
      issuer: RLUSD_MAINNET_ISSUER,
    },
  ],
  [XRPL_TESTNET]: [
    {
      asset: RLUSD_CURRENCY,
      decimals: 15,
      symbol: "RLUSD",
      issuer: RLUSD_TESTNET_ISSUER,
    },
  ],
};

/**
 * Look up a default asset by network and optional ticker.
 *
 * @param network - CAIP-2 network
 * @param symbol - Ticker; omit for the network default
 * @returns Matching entry
 * @throws If network or ticker is unknown
 */
export const getDefaultAsset: GetDefaultAsset<XrplDefaultAsset> = (network, symbol?) => {
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
 * Reverse lookup by currency hex (case-insensitive) and network.
 *
 * @param asset - Currency hex from payment requirements
 * @param network - CAIP-2 network
 * @returns Matching entry, or undefined
 */
export const findDefaultAsset: FindDefaultAsset<XrplDefaultAsset> = (asset, network) => {
  const assets = DEFAULT_ASSETS[network];
  if (!assets) {
    return undefined;
  }
  const normalizedAsset = asset.toUpperCase();
  return assets.find(entry => entry.asset.toUpperCase() === normalizedAsset);
};
