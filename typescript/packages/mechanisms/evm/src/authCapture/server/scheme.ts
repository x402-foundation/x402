/**
 * AuthCapture Scheme - Server
 * Handles price parsing and requirement enhancement for resource servers.
 *
 * Implements x402's SchemeNetworkServer interface so it can be registered
 * on an x402ResourceServer via server.register('eip155:84532', new AuthCaptureEvmScheme()).
 */

import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";
import { AUTH_CAPTURE_SCHEME } from "../constants";

/**
 * Asset info including EIP-712 domain parameters per network. Each entry is the
 * default stablecoin used by `defaultMoneyConversion` when the merchant gives a
 * decimal price like "$1.50".
 *
 * `name` / `version` are the EIP-712 domain used by the ERC-3009
 * `assetTransferMethod`. Whether a token supports ERC-3009 is a token-level
 * capability, not a chain property; merchants whose chosen token lacks
 * `receiveWithAuthorization` (e.g., BSC's Binance-Peg USDC, Tempo's pathUSD)
 * MUST set `assetTransferMethod: "permit2"` in `extra` themselves. The server
 * does not auto-pick a method based on chain. If the wrong method is paired
 * with an incompatible token, the failure surfaces at facilitator simulation.
 */
const ASSET_INFO: Record<
  string,
  {
    address: string;
    name: string;
    version: string;
    decimals: number;
  }
> = {
  // ----- Mainnets -----
  // Ethereum
  "eip155:1": {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  },
  // Base
  "eip155:8453": {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  },
  // Optimism
  "eip155:10": {
    address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  },
  // Arbitrum One
  "eip155:42161": {
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  },
  // Polygon
  "eip155:137": {
    address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  },
  // Celo
  "eip155:42220": {
    address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  },
  // Avalanche C-Chain
  "eip155:43114": {
    address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  },
  // Linea
  "eip155:59144": {
    address: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  },
  // Monad
  "eip155:143": {
    address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  },

  // ----- Testnets -----
  // Ethereum Sepolia
  "eip155:11155111": {
    address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    name: "USDC",
    version: "2",
    decimals: 6,
  },
  // Base Sepolia
  "eip155:84532": {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC",
    version: "2",
    decimals: 6,
  },
  // Arbitrum Sepolia
  "eip155:421614": {
    address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    name: "USDC",
    version: "2",
    decimals: 6,
  },

  // ----- Mainnets where the canonical stable lacks ERC-3009 -----
  // Merchants on these chains MUST set `assetTransferMethod: "permit2"` themselves.
  // BNB Smart Chain — Binance-Peg USDC (18 decimals; no `receiveWithAuthorization`).
  "eip155:56": {
    address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    name: "USDC",
    version: "1",
    decimals: 18,
  },
  // Tempo — pathUSD (TIP-20 predeploy, 6 decimals; no `receiveWithAuthorization`).
  "eip155:4217": {
    address: "0x20c0000000000000000000000000000000000000",
    name: "pathUSD",
    version: "1",
    decimals: 6,
  },
};

/**
 * Convert a decimal amount string to its base-units token representation via
 * string manipulation. Avoids the floating-point rounding errors that arise
 * from `BigInt(Math.round(amount * 10 ** decimals))` on large or precise
 * inputs. Example: `"0.10"` with `decimals=6` → `"100000"`.
 *
 * @param decimalAmount - Decimal amount expressed as a string (e.g. `"0.10"`).
 * @param decimals - Token decimals (USDC = 6, most ERC-20s = 18).
 * @returns The amount in base units as a string.
 * @throws If `decimalAmount` does not parse as a number.
 */
function convertToTokenAmount(decimalAmount: string, decimals: number): string {
  const amount = parseFloat(decimalAmount);
  if (isNaN(amount)) {
    throw new Error(`Invalid amount: ${decimalAmount}`);
  }
  const [intPart, decPart = ""] = String(amount).split(".");
  const paddedDec = decPart.padEnd(decimals, "0").slice(0, decimals);
  const tokenAmount = (intPart + paddedDec).replace(/^0+/, "") || "0";
  return tokenAmount;
}

/**
 * Server-side implementation of the authCapture scheme: maps merchant-friendly
 * prices (`"$0.01"`, decimal numbers, or pre-built `AssetAmount`) to the
 * stablecoin asset + base-unit amount needed in `PaymentRequirements`, and
 * merges facilitator-advertised `extra` fields into the published
 * requirements. Implements `SchemeNetworkServer`.
 */
export class AuthCaptureEvmScheme implements SchemeNetworkServer {
  readonly scheme = AUTH_CAPTURE_SCHEME;
  private moneyParsers: MoneyParser[] = [];

  /**
   * Add a custom money parser to the chain. Parsers run in registration order;
   * the first one to return a non-null `AssetAmount` wins. If every parser
   * returns null, the default network-stablecoin conversion is used.
   *
   * @param parser - Function that maps a decimal amount to an `AssetAmount`, or `null` to defer.
   * @returns This server scheme instance, for fluent chaining.
   */
  registerMoneyParser(parser: MoneyParser): AuthCaptureEvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Translate a merchant-supplied `Price` into a fully-resolved `AssetAmount`.
   * Pass-through for `AssetAmount` inputs (with required `asset` validation);
   * otherwise normalizes the input to a decimal, then runs the registered
   * money parser chain, falling back to the default stablecoin for the network.
   *
   * @param price - `"$0.01"` / `0.01` / `{ asset, amount }`.
   * @param network - CAIP-2 network identifier used for default-asset lookup.
   * @returns The resolved `AssetAmount` containing token address and base units.
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    // If already an AssetAmount, pass through with validation
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra || {},
      };
    }

    // Parse Money to decimal number
    const numericAmount = this.parseMoneyToDecimal(price);

    // Try each custom money parser in order
    for (const parser of this.moneyParsers) {
      const result = await parser(numericAmount, network);
      if (result !== null) {
        return result;
      }
    }

    // All custom parsers returned null (or none registered), use default conversion
    return this.defaultMoneyConversion(numericAmount, network);
  }

  /**
   * Merge facilitator-advertised `extra` (from `/supported`) into the
   * merchant's payment requirements, with the merchant's own `extra` taking
   * precedence on collisions. Lets authCapture wire-level fields (e.g., a
   * facilitator-injected `captureAuthorizer` default) flow into requirements
   * automatically while still allowing the merchant to override.
   *
   * @param requirements - The merchant-authored payment requirements.
   * @param supportedKind - The facilitator's advertised support entry for this scheme/network.
   * @param supportedKind.x402Version - Protocol version the facilitator advertises.
   * @param supportedKind.scheme - Scheme identifier (`"authCapture"`).
   * @param supportedKind.network - CAIP-2 network identifier.
   * @param supportedKind.extra - Facilitator-injected `extra` fields (lowest priority on collision).
   * @param _ - Unused list of facilitator extensions (interface compatibility).
   * @returns Enhanced `PaymentRequirements` with merged `extra`.
   */
  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    _: string[],
  ): Promise<PaymentRequirements> {
    return {
      ...requirements,
      extra: {
        ...supportedKind.extra,
        ...requirements.extra,
      },
    };
  }

  /**
   * Normalize a `Price` (string or number) to a decimal `number`. Strips `$`
   * and `,` formatting characters from strings before parsing.
   *
   * @param money - Decimal money expressed as a number or formatted string.
   * @returns The parsed decimal amount.
   * @throws If the string does not parse as a number.
   */
  private parseMoneyToDecimal(money: string | number): number {
    if (typeof money === "number") {
      return money;
    }
    const cleaned = String(money).replace(/[$,]/g, "").trim();
    const amount = parseFloat(cleaned);
    if (isNaN(amount)) {
      throw new Error(`Cannot parse price: ${money}`);
    }
    return amount;
  }

  /**
   * Fall-through converter: resolves a decimal amount against the default
   * stablecoin registered for the network in `ASSET_INFO`. Returns only the
   * EIP-712 token-domain fields (`name` / `version`) in `extra`; the merchant
   * is responsible for selecting `assetTransferMethod` when the chosen token
   * does not support the spec default (`"eip3009"`).
   *
   * @param amount - Decimal amount in the token's display units.
   * @param network - CAIP-2 network identifier.
   * @returns Resolved `AssetAmount` with the network's default stablecoin.
   * @throws If no default stablecoin is configured for `network`.
   */
  private defaultMoneyConversion(amount: number, network: Network): AssetAmount {
    const assetInfo = ASSET_INFO[network];
    if (!assetInfo) {
      throw new Error(`No USDC address configured for network: ${network}`);
    }

    const tokenAmount = convertToTokenAmount(String(amount), assetInfo.decimals);

    return {
      asset: assetInfo.address,
      amount: tokenAmount,
      extra: {
        name: assetInfo.name,
        version: assetInfo.version,
      },
    };
  }
}
