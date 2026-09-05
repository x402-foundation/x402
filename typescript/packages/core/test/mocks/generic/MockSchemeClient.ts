import {
  DefaultAsset,
  FindDefaultAsset,
  PaymentPayloadContext,
  SchemeClientHooks,
  SchemeNetworkClient,
} from "../../../src/types/mechanisms";
import { PaymentPayload, PaymentRequirements } from "../../../src/types/payments";

/**
 * Mock scheme network client for testing.
 */
export class MockSchemeNetworkClient implements SchemeNetworkClient {
  public readonly scheme: string;
  public readonly schemeHooks?: SchemeClientHooks;
  public findDefaultAsset?: FindDefaultAsset;
  private payloadResult: Pick<PaymentPayload, "x402Version" | "payload"> | Error;

  // Call tracking
  public createPaymentPayloadCalls: Array<{
    x402Version: number;
    requirements: PaymentRequirements;
    context?: PaymentPayloadContext;
  }> = [];

  /**
   *
   * @param scheme
   * @param payloadResult
   */
  constructor(
    scheme: string,
    payloadResult?: Pick<PaymentPayload, "x402Version" | "payload"> | Error,
    schemeHooks?: SchemeClientHooks,
  ) {
    this.scheme = scheme;
    this.payloadResult = payloadResult || {
      x402Version: 2,
      payload: { signature: "mock_signature", from: "mock_address" },
    };
    this.schemeHooks = schemeHooks;
    // Treat any asset as a recognized default so non-spend-control tests pass
    // the default allowlist (USD cap still applies unless overridden).
    this.findDefaultAsset = (asset: string) => ({
      asset,
      decimals: 6,
      symbol: "MOCK",
    });
  }

  /** Set `findDefaultAsset` for spend-control tests. */
  setFindDefaultAsset(lookup: FindDefaultAsset | DefaultAsset): void {
    if (typeof lookup === "function") {
      this.findDefaultAsset = lookup;
    } else {
      this.findDefaultAsset = () => lookup;
    }
  }

  /** Clear `findDefaultAsset` (scheme does not participate in default-asset spend controls). */
  clearFindDefaultAsset(): void {
    this.findDefaultAsset = undefined;
  }

  /**
   *
   * @param x402Version
   * @param paymentRequirements
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    this.createPaymentPayloadCalls.push({
      x402Version,
      requirements: paymentRequirements,
      context,
    });

    if (this.payloadResult instanceof Error) {
      throw this.payloadResult;
    }
    return this.payloadResult;
  }

  // Helper methods for test configuration
  /**
   *
   * @param result
   */
  setPayloadResult(result: Pick<PaymentPayload, "x402Version" | "payload"> | Error): void {
    this.payloadResult = result;
  }

  /**
   *
   */
  reset(): void {
    this.createPaymentPayloadCalls = [];
  }
}
