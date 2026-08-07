/**
 * Type definitions for the Builder Code Extension (ERC-8021)
 *
 * Enables attribution tracking for x402 payments by appending
 * ERC-8021 Schema 2 builder codes to settlement transaction calldata.
 */

import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

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
 * Maximum client-provided service codes reserved in the `s` array. Enforced by
 * {@link BuilderCodeClientExtension} independently of the server's reservation
 * so one side can never crowd out the other.
 */
export const MAX_CLIENT_SERVICE_CODES = 5;

/**
 * Maximum server-declared service codes reserved in the `s` array. Enforced by
 * `declareBuilderCodeExtension` independently of the client's reservation so
 * one side can never crowd out the other.
 */
export const MAX_SERVER_SERVICE_CODES = 5;

/**
 * Maximum facilitator-appended service codes reserved in the `s` array.
 * Enforced by {@link BuilderCodeFacilitatorExtension} for its own
 * `BuilderCodeFacilitatorConfig.serviceCode`.
 */
export const MAX_FACILITATOR_SERVICE_CODES = 1;

/**
 * Maximum number of service codes (`s`) encoded onchain at settlement — the
 * sum of each side's dedicated reservation ({@link MAX_CLIENT_SERVICE_CODES},
 * {@link MAX_SERVER_SERVICE_CODES}, {@link MAX_FACILITATOR_SERVICE_CODES}).
 */
export const MAX_SERVICE_CODES =
  MAX_CLIENT_SERVICE_CODES + MAX_SERVER_SERVICE_CODES + MAX_FACILITATOR_SERVICE_CODES;

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
   * Service builder codes — client-provided attribution codes.
   * Maps to the "s" field in ERC-8021 Schema 2 (encoded as an array on wire).
   * Accepts a single string or an array of strings; normalized to an array internally.
   */
  s?: string | string[];
}

/**
 * Configuration for the builder code facilitator extension.
 */
export interface BuilderCodeFacilitatorConfig {
  /**
   * The facilitator's own builder code, set as the "w" field at settlement when provided.
   */
  builderCode?: string;

  /**
   * The facilitator's own service code, appended to the "s" field at settlement when
   * provided. Reserved independently of the client/server "s" entries (see
   * {@link MAX_FACILITATOR_SERVICE_CODES}).
   */
  serviceCode?: string;
}

export interface DataSuffixContext {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}
