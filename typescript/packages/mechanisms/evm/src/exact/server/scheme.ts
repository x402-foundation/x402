import {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  MoneyParser,
} from "@x402/core/types";

/**
 * EVM server implementation for the Exact payment scheme.
 */
export class ExactEvmScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain.
   * Multiple parsers can be registered - they will be tried in registration order.
   * Each parser receives a decimal amount (e.g., 1.50 for $1.50).
   * If a parser returns null, the next parser in the chain will be tried.
   * The default parser is always the final fallback.
   *
   * @param parser - Custom function to convert amount to AssetAmount (or null to skip)
   * @returns The server instance for chaining
   *
   * @example
   * evmServer.registerMoneyParser(async (amount, network) => {
   *   // Custom conversion logic
   *   if (amount > 100) {
   *     // Use different token for large amounts
   *     return { amount: (amount * 1e18).toString(), asset: "0xCustomToken" };
   *   }
   *   return null; // Use next parser
   * });
   */
  registerMoneyParser(parser: MoneyParser): ExactEvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Parses a price into an asset amount.
   * If price is already an AssetAmount, returns it directly.
   * If price is Money (string | number), parses to decimal and tries custom parsers.
   * Falls back to default conversion if all custom parsers return null.
   *
   * @param price - The price to parse
   * @param network - The network to use
   * @returns Promise that resolves to the parsed asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    // If already an AssetAmount, return it directly
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
    const amount = this.parseMoneyToDecimal(price);

    // Try each custom money parser in order
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    // All custom parsers returned null, use default conversion
    return this.defaultMoneyConversion(amount, network);
  }

  /**
   * Build payment requirements for this scheme/network combination
   *
   * @param paymentRequirements - The base payment requirements
   * @param supportedKind - The supported kind from facilitator (unused)
   * @param supportedKind.x402Version - The x402 version
   * @param supportedKind.scheme - The logical payment scheme
   * @param supportedKind.network - The network identifier in CAIP-2 format
   * @param supportedKind.extra - Optional extra metadata regarding scheme/network implementation details
   * @param extensionKeys - Extension keys supported by the facilitator (unused)
   * @returns Payment requirements ready to be sent to clients
   */
  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    // Mark unused parameters to satisfy linter
    void supportedKind;
    void extensionKeys;
    return Promise.resolve(paymentRequirements);
  }

  /**
   * Parse Money (string | number) to a decimal number.
   * Handles formats like "$1.50", "1.50", 1.50, etc.
   *
   * @param money - The money value to parse
   * @returns Decimal number
   */
  private parseMoneyToDecimal(money: string | number): number {
    if (typeof money === "number") {
      return money;
    }

    // Remove $ sign and whitespace, then parse
    const cleanMoney = money.replace(/^\$/, "").trim();
    const amount = parseFloat(cleanMoney);

    if (isNaN(amount)) {
      throw new Error(`Invalid money format: ${money}`);
    }

    return amount;
  }

  /**
   * Default money conversion implementation.
   * Converts decimal amount to the default stablecoin on the specified network.
   *
   * @param amount - The decimal amount (e.g., 1.50)
   * @param network - The network to use
   * @returns The parsed asset amount in the default stablecoin
   */
  private defaultMoneyConversion(amount: number, network: Network): AssetAmount {
    const assetInfo = this.getDefaultAsset(network);
    const tokenAmount = this.convertToTokenAmount(amount.toString(), assetInfo.decimals);

    // EIP-3009 tokens always need name/version for their transferWithAuthorization domain.
    // Permit2 tokens only need them if the token supports EIP-2612 (for gasless permit signing).
    // Omitting name/version for permit2 tokens signals the client to skip EIP-2612 and use
    // ERC-20 approval gas sponsoring instead.
    const includeEip712Domain = !assetInfo.assetTransferMethod || assetInfo.supportsEip2612;

    return {
      amount: tokenAmount,
      asset: assetInfo.address,
      extra: {
        ...(includeEip712Domain && {
          name: assetInfo.name,
          version: assetInfo.version,
        }),
        ...(assetInfo.assetTransferMethod && {
          assetTransferMethod: assetInfo.assetTransferMethod,
        }),
      },
    };
  }

  /**
   * Convert decimal amount to token units (e.g., 0.10 -> 100000 for 6-decimal tokens)
   *
   * @param decimalAmount - The decimal amount to convert
   * @param decimals - The number of decimals for the token
   * @returns The token amount as a string
   */
  private convertToTokenAmount(decimalAmount: string, decimals: number): string {
    const amount = parseFloat(decimalAmount);
    if (isNaN(amount)) {
      throw new Error(`Invalid amount: ${decimalAmount}`);
    }
    // Convert to smallest unit (e.g., for USDC with 6 decimals: 0.10 * 10^6 = 100000)
    const [intPart, decPart = ""] = String(amount).split(".");
    const paddedDec = decPart.padEnd(decimals, "0").slice(0, decimals);
    const tokenAmount = (intPart + paddedDec).replace(/^0+/, "") || "0";
    return tokenAmount;
  }

  /**
   * Get the default asset info for a network (typically USDC)
   *
   * @param network - The network to get asset info for
   * @returns The asset information including address, name, version, and decimals
   */
  private getDefaultAsset(network: Network): {
    address: string;
    name: string;
    version: string;
    decimals: number;
    assetTransferMethod?: string;
    supportsEip2612?: boolean;
  } {
    // Map of network to stablecoin info including EIP-712 domain parameters.
    // Each network has the right to determine its own default stablecoin that can be expressed as a USD string by calling servers.
    // Tokens that don't support EIP-3009 should set assetTransferMethod: "permit2".
    // For permit2 tokens, set supportsEip2612: true if the token implements EIP-2612 permit().
    // When supportsEip2612 is false/absent on a permit2 token, name/version are omitted from
    // extra so the client skips the EIP-2612 path and falls back to ERC-20 approval gas sponsoring.
    const stablecoins: Record<
      string,
      {
        address: string;
        name: string;
        version: string;
        decimals: number;
        assetTransferMethod?: string;
        supportsEip2612?: boolean;
      }
    > = {
      "eip155:8453": {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        name: "USD Coin",
        version: "2",
        decimals: 6,
      }, // Base mainnet USDC
      "eip155:84532": {
        address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        name: "USDC",
        version: "2",
        decimals: 6,
      }, // Base Sepolia USDC
      "eip155:4326": {
        address: "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7",
        name: "MegaUSD",
        version: "1",
        decimals: 18,
        assetTransferMethod: "permit2",
        supportsEip2612: true,
      }, // MegaETH mainnet MegaUSD (no EIP-3009, supports EIP-2612)
      "eip155:143": {
        address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
        name: "USD Coin",
        version: "2",
        decimals: 6,
      }, // Monad mainnet USDC
      "eip155:31611": {
        address: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
        name: "Mezo USD",
        version: "1",
        decimals: 18,
        assetTransferMethod: "permit2",
        supportsEip2612: true,
      }, // Mezo Testnet mUSD (no EIP-3009, supports EIP-2612)
      "eip155:988": {
        address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
        name: "USDT0",
        version: "1",
        decimals: 6,
      }, // Stable mainnet USDT0
      "eip155:42161": {
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        name: "USD Coin",
        version: "2",
        decimals: 6,
      }, // Arbitrum One USDC
      "eip155:421614": {
        address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
        name: "USD Coin",
        version: "2",
        decimals: 6,
      }, // Arbitrum Sepolia USDC
    };

    const assetInfo = stablecoins[network];
    if (!assetInfo) {
      throw new Error(`No default asset configured for network ${network}`);
    }

    return assetInfo;
  }
}
