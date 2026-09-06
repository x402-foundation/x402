import { PaymentRequired, PaymentPayload, PaymentRequirements } from "../../../src/types/payments";
import { VerifyResponse, SettleResponse, SupportedResponse } from "../../../src/types/facilitator";
import { Network } from "../../../src/types";

/**
 * Test data builders for creating test fixtures.
 */

/**
 *
 * @param overrides
 */
export function buildPaymentRequirements(
  overrides?: Partial<PaymentRequirements>,
): PaymentRequirements {
  return {
    scheme: "test-scheme",
    network: "test:network" as Network,
    amount: "1000000",
    asset: "TEST_ASSET",
    payTo: "test_recipient",
    maxTimeoutSeconds: 300,
    extra: {},
    ...overrides,
  };
}

/**
 *
 * @param overrides
 */
export function buildPaymentRequired(overrides?: Partial<PaymentRequired>): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: "https://example.com/resource",
      description: "Test resource",
      mimeType: "application/json",
    },
    accepts: [buildPaymentRequirements()],
    ...overrides,
  };
}

/**
 *
 * @param overrides
 */
export function buildPaymentPayload(overrides?: Partial<PaymentPayload>): PaymentPayload {
  return {
    x402Version: 2,
    payload: {
      signature: "test_signature",
      from: "test_sender",
    },
    accepted: buildPaymentRequirements(),
    resource: {
      url: "https://example.com/resource",
      description: "Test resource",
      mimeType: "application/json",
    },
    ...overrides,
  };
}

/**
 *
 * @param overrides
 */
export function buildVerifyResponse(overrides?: Partial<VerifyResponse>): VerifyResponse {
  return {
    isValid: true,
    ...overrides,
  };
}

/**
 *
 * @param overrides
 */
export function buildSettleResponse(overrides?: Partial<SettleResponse>): SettleResponse {
  return {
    success: true,
    transaction: "0xTestTransaction",
    network: "test:network" as Network,
    ...overrides,
  };
}

/**
 * Builds a supported response for testing.
 * Uses flat array format with x402Version in each kind for backward compatibility.
 *
 * Args:
 *   overrides: Partial overrides for the supported response
 *
 * Returns:
 *   A complete SupportedResponse object with test defaults
 */
export function buildSupportedResponse(overrides?: Partial<SupportedResponse>): SupportedResponse {
  const base: SupportedResponse = {
    kinds: [
      {
        x402Version: 2,
        scheme: "test-scheme",
        network: "test:network" as Network,
        extra: {},
      },
    ],
    extensions: [],
    signers: {},
  };

  // If overrides are provided, merge them
  if (overrides) {
    if (overrides.kinds !== undefined) {
      base.kinds = overrides.kinds;
    }
    if (overrides.extensions !== undefined) {
      base.extensions = overrides.extensions;
    }
    if (overrides.signers !== undefined) {
      base.signers = overrides.signers;
    }
  }

  return base;
}
