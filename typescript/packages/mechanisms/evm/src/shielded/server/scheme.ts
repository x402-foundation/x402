import type {
  PaymentRequirements,
  Network,
  Price,
  AssetAmount,
} from "@x402/core/types";
import type { SchemeNetworkServer } from "@x402/core/types/mechanisms";
import type { ShieldedServerConfig } from "../types.js";

// Default token addresses per chain (USDC)
const DEFAULT_TOKENS: Record<number, { address: string; decimals: number }> = {
  8453: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  1: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  56: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
  137: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
  42161: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
};

function getChainId(network: string): number {
  return parseInt(network.split(":")[1], 10);
}

export class ShieldedEvmServer implements SchemeNetworkServer {
  readonly scheme = "exact";
  private poolContracts: Record<number, string[]>;
  private defaultDecimals: number;

  constructor(config: ShieldedServerConfig) {
    this.poolContracts = config.poolContracts;
    this.defaultDecimals = config.defaultDecimals ?? 6;
  }

  getAssetDecimals(_asset: string, _network: Network): number {
    return this.defaultDecimals;
  }

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    // Pass through AssetAmount objects
    if (typeof price === "object" && price !== null && "amount" in price) {
      return price as AssetAmount;
    }

    const chainId = getChainId(network);
    const token = DEFAULT_TOKENS[chainId];
    if (!token) {
      throw new Error(`No default token for chain ${chainId}`);
    }

    // Parse dollar string or number
    let amount: number;
    if (typeof price === "string") {
      amount = parseFloat(price.replace(/^\$/, ""));
    } else {
      amount = price as number;
    }

    const atomicAmount = Math.round(amount * 10 ** token.decimals);

    return {
      amount: atomicAmount.toString(),
      asset: token.address,
      extra: {},
    };
  }

  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    _supportedKind: { x402Version: number; scheme: string; network: Network },
    _extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    const chainId = getChainId(requirements.network);
    const pools = this.poolContracts[chainId] ?? [];

    return {
      ...requirements,
      extra: {
        ...requirements.extra,
        assetTransferMethod: "shielded",
        poolContracts: pools,
      },
    };
  }
}
