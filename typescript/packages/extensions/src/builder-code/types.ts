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
 * - a: app/agent code (the entity that initiated the payment)
 * - s: service codes array (facilitator, service endpoint, platform, etc.)
 */
export interface BuilderCodeExtensionData {
  /**
   * App/agent builder code — the entity that initiated the payment.
   * Maps to the "a" field in ERC-8021 Schema 2.
   */
  a?: string;

  /**
   * Service builder codes — service-layer participants involved in the transaction.
   * Maps to the "s" field in ERC-8021 Schema 2.
   * Includes: facilitator, service endpoint, platform, etc.
   */
  s?: string[];
}

/**
 * Configuration for the builder code facilitator extension.
 */
export interface BuilderCodeFacilitatorConfig {
  /**
   * The facilitator's own builder code, added to the "s" array at settlement.
   */
  builderCode: string;
}

/**
 * Configuration for the builder code client extension.
 */
export interface BuilderCodeClientConfig {
  /**
   * The agent/app's own builder code, set as the "a" field.
   */
  builderCode: string;
}
