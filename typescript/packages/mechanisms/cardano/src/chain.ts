import { Assets, type Chain, mainnet, preprod, preview } from "@evolution-sdk/evolution";

import {
  CARDANO_MAINNET_CAIP2,
  CARDANO_PREPROD_CAIP2,
  CARDANO_PREVIEW_CAIP2,
  LOVELACE_ASSET,
  normalizeCardanoNetwork,
} from "./constants";
import { parseAssetUnit } from "./utils";

/**
 * Resolves an x402 Cardano network identifier to an Evolution SDK chain preset.
 *
 * @param network - The x402 network identifier (e.g. "cardano:mainnet").
 * @returns The matching Evolution SDK chain preset.
 */
export function resolveCardanoChain(network: string): Chain {
  switch (normalizeCardanoNetwork(network)) {
    case CARDANO_MAINNET_CAIP2:
      return mainnet;
    case CARDANO_PREPROD_CAIP2:
      return preprod;
    case CARDANO_PREVIEW_CAIP2:
      return preview;
    default:
      throw new Error(`Unsupported Cardano network: ${network}`);
  }
}

/**
 * Builds the payment-output assets for the requested asset/amount. Lovelace
 * lives in the output coin; native assets live in the multi-asset map.
 *
 * @param asset - The asset unit (`lovelace` or `policyId.assetNameHex`).
 * @param amount - The amount in the asset's smallest unit.
 * @returns Evolution SDK assets describing the output value.
 */
export function buildPaymentOutputAssets(asset: string, amount: bigint): Assets.Assets {
  if (asset.toLowerCase() === LOVELACE_ASSET) {
    return Assets.fromLovelace(amount);
  }
  const { policyId, assetNameHex } = parseAssetUnit(asset);
  // Native-asset outputs still require lovelace; build() bumps it to the
  // protocol minimum when autoMinUtxo is enabled.
  return Assets.addByHex(Assets.zero, policyId, assetNameHex, amount);
}
