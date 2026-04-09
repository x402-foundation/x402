/**
 * Type definitions for the Builder Code Extension (ERC-8021)
 *
 * Enables attribution tracking for x402 payments by appending
 * ERC-8021 Schema 2 builder codes to settlement transaction calldata.
 */

/**
 * Extension identifier constant
 */
export const BUILDER_CODE = "builder-code";

/**
 * ERC-8021 marker bytes (16 bytes) appended at the end of every suffix
 */
export const ERC_8021_MARKER = "80218021802180218021802180218021";

/**
 * Schema 2 identifier byte
 */
export const SCHEMA_2_ID = 0x02;

/**
 * Pattern for valid builder codes (lowercase alphanumeric + underscore, 1-32 chars)
 */
export const BUILDER_CODE_PATTERN = /^[a-z0-9_]{1,32}$/;

/**
 * Builder code extension data as it appears in PaymentRequired/PaymentPayload extensions.
 *
 * Maps to ERC-8021 Schema 2 fields:
 * - a: app code (the x402 service that exposed the endpoint)
 * - w: wallet code (the facilitator that settled the payment on-chain)
 * - s: service codes array (related on-chain services the app depends on)
 */
export interface BuilderCodeExtensionData {
  /**
   * App builder code — the x402 service that exposed the paid endpoint.
   * Maps to the "a" field in ERC-8021 Schema 2.
   * Set by the service in the 402 response.
   */
  a?: string;

  /**
   * Wallet builder code — the facilitator that settled the payment on-chain.
   * Maps to the "w" field in ERC-8021 Schema 2.
   * Set by the facilitator at settlement time.
   */
  w?: string;

  /**
   * Service builder codes — related on-chain services the app depends on.
   * Maps to the "s" field in ERC-8021 Schema 2.
   * Optionally set by the service to attribute protocols it interacts with
   * (e.g., Morpho for lending, Aerodrome for swaps).
   */
  s?: string[];
}

/**
 * Configuration for the builder code facilitator extension.
 */
export interface BuilderCodeFacilitatorConfig {
  /**
   * The facilitator's own builder code, set as the "w" field at settlement.
   */
  builderCode: string;
}
