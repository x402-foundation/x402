import { x402Facilitator } from "../../../../src/facilitator";
import { FacilitatorClient } from "../../../../src/server";
import {
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "../../../../src/types/facilitator";
import {
  SchemeNetworkClient,
  SchemeNetworkFacilitator,
  SchemeNetworkServer,
} from "../../../../src/types/mechanisms";
import { PaymentPayload, PaymentRequirements } from "../../../../src/types/payments";
import { Price, AssetAmount, Network } from "../../../../src/types";

/**
 *
 */
export class CashSchemeNetworkClient implements SchemeNetworkClient {
  readonly scheme = "cash";

  /**
   * Creates a new CashClient instance.
   *
   * @param payer - The address of the payer
   */
  constructor(private readonly payer: string) {}

  /**
   * Creates a payment payload for the cash scheme.
   *
   * @param x402Version - The x402 protocol version
   * @param requirements - The payment requirements
   * @returns Promise resolving to the payment payload
   */
  createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<PaymentPayload> {
    return Promise.resolve({
      x402Version: 2,
      scheme: requirements.scheme,
      network: requirements.network,
      payload: {
        signature: `~${this.payer}`,
        validUntil: (Date.now() + requirements.maxTimeoutSeconds).toString(),
        name: this.payer,
      },
      accepted: requirements,
    });
  }
}

/**
 *
 */
export class CashSchemeNetworkFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = "cash";

  /**
   * Get mechanism-specific extra data for the supported kinds endpoint.
   * For the mock cash scheme, return empty object.
   *
   * @param _ - The network identifier
   * @returns Empty extra data object
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    return {};
  }

  /**
   * Verifies a payment payload against requirements.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements to verify against
   * @returns Promise resolving to the verification response
   */
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    // Requirements parameter is not used in this implementation
    void requirements;
    if (payload.payload.signature !== `~${payload.payload.name}`) {
      return Promise.resolve({
        isValid: false,
        invalidReason: "invalid_signature",
        payer: undefined,
      });
    }

    if (payload.payload.validUntil < Date.now().toString()) {
      return Promise.resolve({
        isValid: false,
        invalidReason: "expired_signature",
        payer: undefined,
      });
    }

    return Promise.resolve({
      isValid: true,
      invalidReason: undefined,
      payer: payload.payload.signature,
    });
  }

  /**
   * Settles a payment based on the payload and requirements.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements for settlement
   * @returns Promise resolving to the settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const verifyResponse = await this.verify(payload, requirements);
    if (!verifyResponse.isValid) {
      return {
        success: false,
        errorReason: verifyResponse.invalidReason,
        payer: verifyResponse.payer,
        transaction: "",
        network: requirements.network,
      };
    }

    return {
      success: true,
      errorReason: undefined,
      transaction: `${payload.payload.name} transferred ${requirements.amount} ${requirements.asset} to ${requirements.payTo}`,
      network: requirements.network,
      payer: payload.payload.signature,
    };
  }
}

/**
 * Creates a payment receipt for the cash scheme.
 *
 * @param payTo - The recipient address
 * @param asset - The asset being paid
 * @param amount - The amount being paid
 * @returns The payment receipt object
 */
export function buildCashPaymentRequirements(
  payTo: string,
  asset: string,
  amount: string,
): PaymentRequirements {
  return {
    scheme: "cash",
    network: "x402:cash",
    asset: asset,
    amount: amount,
    payTo: payTo,
    maxTimeoutSeconds: 1000,
    extra: {},
  };
}

/**
 *
 */
export class CashSchemeNetworkServer implements SchemeNetworkServer {
  readonly scheme = "cash";

  /**
   * Parses a price into asset amount format.
   *
   * @param price - The price to parse
   * @param network - The network identifier
   * @returns Promise resolving to the parsed asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    // Network parameter is not used in this implementation
    void network;
    // Handle pre-parsed price object
    if (typeof price === "object" && price !== null && "amount" in price) {
      return {
        amount: price.amount,
        asset: price.asset || "USD",
        extra: {},
      };
    }

    // Parse string prices like "$10" or "10 USD"
    if (typeof price === "string") {
      const cleanPrice = price
        .replace(/^\$/, "")
        .replace(/\s+USD$/i, "")
        .trim();
      return {
        amount: cleanPrice,
        asset: "USD",
        extra: {},
      };
    }

    // Handle number input
    if (typeof price === "number") {
      return {
        amount: price.toString(),
        asset: "USD",
        extra: {},
      };
    }

    throw new Error(`Invalid price format: ${price}`);
  }

  /**
   * Enhances payment requirements with cash-specific details.
   *
   * @param paymentRequirements - Base payment requirements
   * @param supportedKind - The supported kind from facilitator
   * @param supportedKind.x402Version - The x402 version
   * @param supportedKind.scheme - The payment scheme
   * @param supportedKind.network - The network identifier
   * @param supportedKind.extra - Optional extra metadata
   * @param facilitatorExtensions - Extensions supported by facilitator
   * @returns Promise resolving to enhanced payment requirements
   */
  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    // Cash scheme doesn't need any special enhancements
    // Parameters are not used in this implementation
    void supportedKind;
    void facilitatorExtensions;
    return paymentRequirements;
  }
}

/**
 *
 */
export class CashFacilitatorClient implements FacilitatorClient {
  readonly scheme = "cash";
  readonly network = "x402:cash";
  readonly x402Version = 2;

  /**
   * Registers a facilitator for the cash scheme.
   *
   * @param facilitator - The cash facilitator to register
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * Verifies a payment payload against requirements.
   *
   * @param paymentPayload - The payment payload to verify
   * @param paymentRequirements - The payment requirements to verify against
   * @returns Promise resolving to the verification response
   */
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  /**
   * Settles a payment based on the payload and requirements.
   *
   * @param paymentPayload - The payment payload to settle
   * @param paymentRequirements - The payment requirements for settlement
   * @returns Promise resolving to the settlement response
   */
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  /**
   * Gets supported payment kinds and extensions.
   *
   * @returns Promise resolving to the supported response
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve({
      kinds: [
        {
          x402Version: this.x402Version,
          scheme: this.scheme,
          network: this.network,
          extra: {},
        },
      ],
      extensions: [],
      signers: {},
    });
  }
}
