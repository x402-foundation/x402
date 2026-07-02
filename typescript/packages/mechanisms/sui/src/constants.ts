// Portions copyright 2026 Danny Devs (https://github.com/Danny-Devs/x402-sui), Apache-2.0

import { normalizeStructTag } from "@mysten/sui/utils";
import type { Network } from "@x402/core/types";

/**
 * CAIP-2 network identifier for Sui Mainnet (matches the merged-spec example).
 */
export const SUI_MAINNET_CAIP2 = "sui:mainnet";

/**
 * CAIP-2 network identifier for Sui Testnet.
 */
export const SUI_TESTNET_CAIP2 = "sui:testnet";

/**
 * CAIP-2 network identifier for Sui Devnet.
 */
export const SUI_DEVNET_CAIP2 = "sui:devnet";

/**
 * Native Circle USDC on Sui mainnet (CCTP) — the canonical USDC, NOT the
 * deprecated Wormhole-bridged version.
 */
export const USDC_MAINNET =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

/**
 * Circle native USDC on Sui testnet.
 */
export const USDC_TESTNET =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";

/**
 * USDC decimal places (the same everywhere Circle USDC ships).
 */
export const USDC_DECIMALS = 6;

/**
 * Default RPC URL for Sui mainnet.
 */
export const MAINNET_RPC_URL = "https://fullnode.mainnet.sui.io:443";

/**
 * Default RPC URL for Sui testnet.
 */
export const TESTNET_RPC_URL = "https://fullnode.testnet.sui.io:443";

/**
 * Default RPC URL for Sui devnet.
 */
export const DEVNET_RPC_URL = "https://fullnode.devnet.sui.io:443";

/**
 * Sui address validation regex (0x followed by 64 hex characters).
 * Short-form addresses (e.g. "0x2") must be normalized to full length first.
 */
export const SUI_ADDRESS_REGEX = /^0x[a-fA-F0-9]{64}$/;

/**
 * The minimum per-transfer amount the protocol applies to gasless transfers on
 * networks that enforce the allowlist parameter (0.01 USDC = 10_000 atomic units).
 *
 * NOTE: this is a PROTOCOL PARAMETER, not a verification invariant — testnet does
 * not always enforce it. Verification anchors on exact amounts regardless. Below
 * this on an enforcing network, the payer falls back to the classic `Coin<T>` path.
 */
export const MIN_GASLESS_TRANSFER = 10_000n;

/**
 * Fully-normalized package id for the Sui framework (0x2).
 */
const FRAMEWORK = "0x0000000000000000000000000000000000000000000000000000000000000002";

/**
 * The protocol-allowlisted Move call targets a gasless stablecoin transfer may
 * use. Every MoveCall command in a gasless transaction MUST resolve to one of
 * these (after normalization). The SDK's `tx.balance({ type, balance })` input
 * resolves to `balance::redeem_funds` for an Address Balance and `coin::into_balance`
 * for a `Coin<T>`, then `balance::send_funds` (and, for a coin source, a final
 * `coin::send_funds`) to the recipient.
 *
 * These are exactly the four functions that EXIST on testnet and mainnet, verified
 * via `sui_getNormalizedMoveFunction`. Earlier drafts also listed
 * `0x2::balance::withdrawal_split` and `0x2::balance::into_balance` — neither exists
 * on-chain (the SDK never emits them); they are removed so the allowlist matches the
 * actual framework.
 *
 * Keys are `package::module::function` with the package id fully normalized.
 */
export const GASLESS_ALLOWED_TARGETS: ReadonlySet<string> = new Set([
  `${FRAMEWORK}::balance::send_funds`,
  `${FRAMEWORK}::balance::redeem_funds`,
  `${FRAMEWORK}::coin::send_funds`,
  `${FRAMEWORK}::coin::into_balance`,
]);

/**
 * Native (non-MoveCall) PTB commands a gasless payment may carry. When the payer
 * sources the transfer from a `Coin<T>` OBJECT (the COMMON case — anyone who just
 * received USDC via a classic coin transfer, with zero Address Balance), the SDK's
 * `tx.balance({ type, balance })` intent resolves to a PTB that first SPLITS exact
 * change off the coin (`SplitCoins`) and may MERGE coin fragments (`MergeCoins`),
 * then converts to a balance and sends it. These commands move no asset to a third
 * party — `TransferObjects` (the object-leak vector) and every other command stay
 * rejected, and the exact-fee balance-change check (Verification step 5) binds the
 * ACTUAL money movement regardless, so tolerating coin plumbing is safe.
 */
export const GASLESS_ALLOWED_NON_MOVECALL: ReadonlySet<string> = new Set([
  "SplitCoins",
  "MergeCoins",
]);

/**
 * Get the default USDC coin type for a network. Devnet has no default asset:
 * a price string on devnet is rejected (AssetAmount must be passed explicitly).
 *
 * @param network - CAIP-2 network identifier
 * @returns USDC coin type string
 */
export function getUsdcCoinType(network: Network): string {
  switch (network) {
    case SUI_MAINNET_CAIP2:
      return USDC_MAINNET;
    case SUI_TESTNET_CAIP2:
      return USDC_TESTNET;
    default:
      throw new Error(`No default USDC coin type configured for network: ${network}`);
  }
}

/**
 * Normalize a `package::module::function` Move call target so that the package
 * id is fully zero-padded (the SDK emits `0x2`, the allowlist stores the long form).
 *
 * @param packageId - The package address of the Move call
 * @param moduleName - The module name of the Move call
 * @param functionName - The function name of the Move call
 * @returns The normalized `package::module::function` string
 */
export function normalizeMoveTarget(
  packageId: string,
  moduleName: string,
  functionName: string,
): string {
  // normalizeStructTag pads the address portion; reuse it via a synthetic struct.
  const normalized = normalizeStructTag(`${packageId}::${moduleName}::${functionName}`);
  return normalized;
}
