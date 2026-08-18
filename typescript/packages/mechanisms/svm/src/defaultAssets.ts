import type {
  DefaultAsset,
  DefaultAssetTable,
  FindDefaultAsset,
  GetDefaultAsset,
  Network,
} from "@x402/core/types";
import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "./constants";
import { normalizeNetwork } from "./constants";

export type SvmDefaultAsset = DefaultAsset & {
  /** Program owning the mint: SPL Token or Token-2022. */
  tokenProgram: string;
};

export const USDC_MAINNET_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DEVNET_ADDRESS = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const USDC_TESTNET_ADDRESS = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** Default USD-pegged assets by CAIP-2 network; index 0 is the `"$0.10"` default. */
export const DEFAULT_ASSETS: DefaultAssetTable<SvmDefaultAsset> = {
  [SOLANA_MAINNET_CAIP2]: [
    {
      asset: USDC_MAINNET_ADDRESS,
      decimals: 6,
      symbol: "USDC",
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    },
    {
      asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      decimals: 6,
      symbol: "USDT",
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    },
    {
      asset: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
      decimals: 6,
      symbol: "USDG",
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    },
    {
      asset: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
      decimals: 6,
      symbol: "PYUSD",
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    },
    {
      asset: "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH",
      decimals: 6,
      symbol: "CASH",
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    },
  ],
  [SOLANA_DEVNET_CAIP2]: [
    {
      asset: USDC_DEVNET_ADDRESS,
      decimals: 6,
      symbol: "USDC",
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    },
    {
      asset: "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7",
      decimals: 6,
      symbol: "USDG",
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    },
    {
      asset: "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM",
      decimals: 6,
      symbol: "PYUSD",
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    },
  ],
  [SOLANA_TESTNET_CAIP2]: [
    {
      asset: USDC_TESTNET_ADDRESS,
      decimals: 6,
      symbol: "USDC",
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    },
    {
      asset: "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7",
      decimals: 6,
      symbol: "USDG",
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    },
    {
      asset: "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM",
      decimals: 6,
      symbol: "PYUSD",
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    },
  ],
};

/**
 * Map CAIP-2 or v1 name to a {@link DEFAULT_ASSETS} key.
 *
 * @param network - CAIP-2 or legacy Solana network id
 * @returns Normalized CAIP-2 network key
 */
function resolveNetworkKey(network: Network): string {
  return normalizeNetwork(network);
}

/**
 * Look up a default asset by network and optional ticker.
 *
 * @param network - CAIP-2 or v1 network
 * @param symbol - Ticker; omit for the network default
 * @returns Matching entry
 * @throws If network or ticker is unknown
 */
export const getDefaultAsset: GetDefaultAsset<SvmDefaultAsset> = (network, symbol?) => {
  const key = resolveNetworkKey(network);
  const assets = DEFAULT_ASSETS[key];
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
 * @param asset - Mint address from payment requirements
 * @param network - CAIP-2 or v1 network
 * @returns Matching entry, or undefined
 */
export const findDefaultAsset: FindDefaultAsset<SvmDefaultAsset> = (asset, network) => {
  const key = resolveNetworkKey(network);
  const assets = DEFAULT_ASSETS[key];
  if (!assets) {
    return undefined;
  }
  return assets.find(entry => entry.asset === asset);
};
