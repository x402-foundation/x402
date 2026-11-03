/**
 * Default asset lookup. Canton Coin ("CC") is the network's native unit
 * (1 CC = 1e10 atomic units); it is not a USD-pegged stablecoin, so there is no
 * dollar-string peg here. Merchants price in an explicit `AssetAmount`
 * (`{ amount: "<atomic>", asset: "CC" }` for Canton Coin, or a registry token's
 * `{ admin, id }`); a bare `"$0.10"` money string has no CC conversion without an
 * out-of-band oracle and is therefore not supported for this scheme.
 */
import type { DefaultAsset, Network } from "@x402/core/types";
import { CANTON_COIN_DECIMALS, CANTON_COIN_SYMBOL } from "./constants.js";
import { isCantonNetwork } from "./types.js";

/** The Canton Coin default asset (per-network, but identity is symbolic). */
export const CANTON_COIN_ASSET: DefaultAsset = {
  asset: CANTON_COIN_SYMBOL,
  decimals: CANTON_COIN_DECIMALS,
  symbol: CANTON_COIN_SYMBOL,
};

/**
 * The default asset entry for a symbol on a Canton network, or undefined.
 *
 * @param asset - Asset symbol ("CC" / "canton-coin") or structured id.
 * @param network - The Canton network.
 * @returns The default asset entry (Canton Coin), or undefined when unknown.
 */
export function findDefaultAsset(asset: string, network: Network): DefaultAsset | undefined {
  if (!isCantonNetwork(network)) return undefined;
  if (asset === CANTON_COIN_SYMBOL || asset === "canton-coin") return CANTON_COIN_ASSET;
  return undefined;
}
