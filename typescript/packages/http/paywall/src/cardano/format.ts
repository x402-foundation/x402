import { Bytes, CBOR } from "@evolution-sdk/evolution";
import {
  DEFAULT_ASSETS,
  LOVELACE_ASSET,
  minUtxoLovelace,
  type Cip30ProtocolParameters,
} from "@x402/cardano";

/** How the page names and scales an asset. */
export interface AssetLabel {
  /** Ticker or short identifier. */
  symbol: string;
  /** Decimal places, or undefined when unknown (amounts are shown in raw units). */
  decimals?: number;
}

const NETWORK_NAMES: Record<string, string> = {
  "cardano:mainnet": "Cardano Mainnet",
  "cardano:preprod": "Cardano Preprod",
  "cardano:preview": "Cardano Preview",
};

const EXPLORERS: Record<string, string> = {
  "cardano:mainnet": "https://explorer.cardano.org/mainnet/tx/",
  "cardano:preprod": "https://explorer.cardano.org/preprod/tx/",
  "cardano:preview": "https://explorer.cardano.org/preview/tx/",
};

/**
 * Testnet faucet per network. Kept here rather than in the shared
 * `FAUCET_URLS` map, which every chain's page bundles.
 */
export const CARDANO_FAUCET_URLS: Readonly<Record<string, string>> = {
  "cardano:preprod": "https://docs.cardano.org/cardano-testnets/tools/faucet",
  "cardano:preview": "https://docs.cardano.org/cardano-testnets/tools/faucet",
};

/**
 * Faucet link for a Cardano testnet; a server `faucetUrls` override wins.
 *
 * @param network - Canonical `cardano:*` id.
 * @param overrides - `PaywallConfig.faucetUrls`.
 * @returns URL, or undefined (mainnet or unknown).
 */
export function cardanoFaucetUrl(
  network: string,
  overrides?: Record<string, string>,
): string | undefined {
  if (!isCardanoTestnet(network)) return undefined;
  return overrides?.[network] ?? CARDANO_FAUCET_URLS[network];
}

/**
 * Human name of a canonical Cardano network.
 *
 * @param network - Canonical `cardano:*` id.
 * @returns Display name.
 */
export function cardanoNetworkName(network: string): string {
  return NETWORK_NAMES[network] ?? network;
}

/**
 * Whether a canonical Cardano network is a testnet.
 *
 * @param network - Canonical `cardano:*` id.
 * @returns True for preprod and preview.
 */
export function isCardanoTestnet(network: string): boolean {
  return network === "cardano:preprod" || network === "cardano:preview";
}

/**
 * Explorer link for a transaction.
 *
 * @param network - Canonical `cardano:*` id.
 * @param txId - Transaction hash.
 * @returns URL, or undefined for unknown networks.
 */
export function explorerTxUrl(network: string, txId: string): string | undefined {
  const base = EXPLORERS[network];
  // The id is read back from localStorage; only link a well-formed hash.
  return base && /^[0-9a-f]{64}$/i.test(txId) ? `${base}${txId.toLowerCase()}` : undefined;
}

/**
 * Labels an asset unit for display. Never guesses decimals for unknown tokens.
 *
 * @param asset - `lovelace` or `policyId.assetNameHex`.
 * @param network - Canonical `cardano:*` id.
 * @returns Symbol and decimals.
 */
export function describeAsset(asset: string, network: string): AssetLabel {
  const unit = asset.toLowerCase();
  if (unit === LOVELACE_ASSET) return { symbol: "ADA", decimals: 6 };
  const known = (DEFAULT_ASSETS[network as keyof typeof DEFAULT_ASSETS] ?? []).find(
    entry => entry.asset.toLowerCase() === unit,
  );
  if (known) return { symbol: known.symbol, decimals: known.decimals };
  const [policy] = unit.split(".");
  return { symbol: `token ${policy.slice(0, 8)}…` };
}

/**
 * Formats an amount in smallest units for display.
 *
 * @param units - Amount in smallest units.
 * @param label - Asset label.
 * @returns e.g. "1.50 USDM", "2 ADA" or "1500 units of token 1a2b3c4d…".
 */
export function formatAmount(units: bigint, label: AssetLabel): string {
  const { value, unit } = formatAmountParts(units, label);
  return `${value} ${unit}`;
}

/**
 * Splits a display amount into its number and unit (for the page header).
 *
 * @param units - Amount in smallest units.
 * @param label - Asset label.
 * @returns e.g. `{ value: "1.50", unit: "USDM" }` or `{ value: "1500", unit: "units of token …" }`.
 */
export function formatAmountParts(
  units: bigint,
  label: AssetLabel,
): { value: string; unit: string } {
  if (label.decimals === undefined) return { value: `${units}`, unit: `units of ${label.symbol}` };
  const scale = 10n ** BigInt(label.decimals);
  const whole = units / scale;
  const frac = (units % scale).toString().padStart(label.decimals, "0").replace(/0+$/, "");
  const value =
    frac.length === 0 ? `${whole}` : `${whole}.${frac.length === 1 ? `${frac}0` : frac}`;
  return { value, unit: label.symbol };
}

/** A decoded CIP-30 balance. */
export interface WalletBalance {
  lovelace: bigint;
  /** `policy.nameHex → quantity`. */
  assets: Record<string, bigint>;
}

/**
 * Decodes a CIP-30 `getBalance()` CBOR value (`coin` or `[coin, multiasset]`).
 *
 * @param cborHex - CBOR hex from the wallet.
 * @returns The balance, or undefined if it cannot be decoded.
 */
export function decodeWalletBalance(cborHex: string): WalletBalance | undefined {
  try {
    const value = CBOR.fromCBORHex(cborHex);
    if (typeof value === "bigint") return { lovelace: value, assets: {} };
    if (!Array.isArray(value) || typeof value[0] !== "bigint" || !(value[1] instanceof Map)) {
      return undefined;
    }
    const assets: Record<string, bigint> = {};
    for (const [policy, names] of value[1] as Map<unknown, unknown>) {
      if (!(policy instanceof Uint8Array) || !(names instanceof Map)) return undefined;
      for (const [name, qty] of names) {
        if (!(name instanceof Uint8Array) || typeof qty !== "bigint") return undefined;
        assets[`${Bytes.toHex(policy)}.${Bytes.toHex(name)}`] = qty;
      }
    }
    return { lovelace: value[0], assets };
  } catch {
    return undefined;
  }
}

/**
 * One-line wallet balance for the page: the paid asset and ADA.
 *
 * @param balance - Decoded balance, if known.
 * @param asset - Paid asset unit.
 * @param label - Paid asset label.
 * @param ada - ADA label.
 * @returns e.g. "42 USDM · 118.36 ADA", or "–" when unknown.
 */
export function summarizeBalance(
  balance: WalletBalance | undefined,
  asset: string,
  label: AssetLabel,
  ada: AssetLabel,
): string {
  if (!balance) return "–";
  const adaText = formatAmount(balance.lovelace, ada);
  if (asset.toLowerCase() === LOVELACE_ASSET) return adaText;
  return `${formatAmount(balance.assets[asset.toLowerCase()] ?? 0n, label)} · ${adaText}`;
}

/**
 * Whether a known balance cannot cover the payment plus its estimated extra
 * ADA. Unknown balances or estimates never block (the build would fail anyway).
 *
 * @param balance - Decoded balance, if known.
 * @param asset - Paid asset unit.
 * @param amount - Amount in smallest units.
 * @param extraLovelace - Estimated fee (+ min-UTxO for tokens), if known.
 * @returns True when the wallet visibly lacks funds.
 */
export function lacksFunds(
  balance: WalletBalance | undefined,
  asset: string,
  amount: bigint,
  extraLovelace: bigint | undefined,
): boolean {
  if (!balance || extraLovelace === undefined) return false;
  if (asset.toLowerCase() === LOVELACE_ASSET) return balance.lovelace < amount + extraLovelace;
  return (balance.assets[asset.toLowerCase()] ?? 0n) < amount || balance.lovelace < extraLovelace;
}

/**
 * Rough extra ADA a payment consumes besides the amount: the network fee and,
 * for token payments, the minimum ADA that must travel with the token. Shown
 * before the build as an estimate.
 *
 * @param isToken - Whether the payment is a native token.
 * @param params - Bounded protocol parameters.
 * @returns Estimated lovelace.
 */
export function estimateExtraLovelace(isToken: boolean, params: Cip30ProtocolParameters): bigint {
  // A one-input, two-output payment is ~300 bytes before witnesses (~100 each).
  const fee = BigInt(params.minFeeB) + BigInt(params.minFeeA) * 450n;
  // A token output is ~90 serialized bytes.
  const minUtxo = isToken ? minUtxoLovelace(90, params.coinsPerUtxoByte) : 0n;
  return fee + minUtxo;
}

/**
 * Shortens a long identifier for display.
 *
 * @param id - Identifier.
 * @returns e.g. "9c41e2ab…aab07a".
 */
export function shortId(id: string): string {
  return id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

/**
 * Rounds lovelace up to 0.1 ADA for "about" copy.
 *
 * @param lovelace - Amount.
 * @returns Rounded amount.
 */
export function roundUpToTenthAda(lovelace: bigint): bigint {
  return ((lovelace + 99_999n) / 100_000n) * 100_000n;
}
