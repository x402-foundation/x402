import { SchemeNetworkServer } from "../../../src/types/mechanisms";
import { AssetAmount, Network, Price } from "../../../src/types";
import { PaymentRequirements } from "../../../src/types/payments";

/**
 * Mock scheme network server for testing.
 */
export class MockSchemeNetworkServer implements SchemeNetworkServer {
  public readonly scheme: string;
  private parsePriceResult: AssetAmount | Error;
  private enhanceResult: PaymentRequirements | Error | null = null;
  private assetDecimalsResult: number | null = null;

  // Call tracking
  public parsePriceCalls: Array<{ price: Price; network: Network }> = [];
  public enhanceCalls: Array<{ requirements: PaymentRequirements }> = [];

  /**
   *
   * @param scheme
   * @param parsePriceResult
   */
  constructor(
    scheme: string,
    parsePriceResult: AssetAmount = { amount: "1000000", asset: "USDC", extra: {} },
  ) {
    this.scheme = scheme;
    this.parsePriceResult = parsePriceResult;
  }

  /**
   *
   * @param price
   * @param network
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    this.parsePriceCalls.push({ price, network });

    if (this.parsePriceResult instanceof Error) {
      throw this.parsePriceResult;
    }
    return this.parsePriceResult;
  }

  /**
   *
   * @param paymentRequirements
   * @param supportedKind
   * @param supportedKind.x402Version
   * @param supportedKind.scheme
   * @param supportedKind.network
   * @param supportedKind.extra
   * @param facilitatorExtensions
   */
  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    _supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    this.enhanceCalls.push({ requirements: paymentRequirements });

    if (this.enhanceResult instanceof Error) {
      throw this.enhanceResult;
    }

    // If no custom result, return the input
    return this.enhanceResult || paymentRequirements;
  }

  getAssetDecimals(_asset: string, _network: Network): number {
    return this.assetDecimalsResult ?? 6;
  }

  // Helper methods for test configuration
  /**
   *
   * @param result
   */
  setAssetDecimalsResult(result: number): void {
    this.assetDecimalsResult = result;
  }

  /**
   *
   * @param result
   */
  setParsePriceResult(result: AssetAmount | Error): void {
    this.parsePriceResult = result;
  }

  /**
   *
   * @param result
   */
  setEnhanceResult(result: PaymentRequirements | Error): void {
    this.enhanceResult = result;
  }

  /**
   *
   */
  reset(): void {
    this.parsePriceCalls = [];
    this.enhanceCalls = [];
  }
}
