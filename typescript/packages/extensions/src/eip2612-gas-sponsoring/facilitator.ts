/**
 * Facilitator functions for extracting and validating EIP-2612 Gas Sponsoring extension data.
 *
 * These functions help facilitators extract the EIP-2612 permit data from payment
 * payloads and validate it before calling settleWithPermit.
 */

import type { PaymentPayload } from "@x402/core/types";
import {
  EIP2612_GAS_SPONSORING,
  type Eip2612GasSponsoringInfo,
  type Eip2612GasSponsoringExtension,
} from "./types";

/**
 * Extracts the EIP-2612 gas sponsoring info from a payment payload's extensions.
 *
 * Returns the info if the extension is present and contains the required client-populated
 * fields (from, asset, spender, amount, nonce, deadline, signature, version).
 *
 * @param paymentPayload - The payment payload to extract from
 * @returns The EIP-2612 gas sponsoring info, or null if not present
 */
export function extractEip2612GasSponsoringInfo(
  paymentPayload: PaymentPayload,
): Eip2612GasSponsoringInfo | null {
  if (!paymentPayload.extensions) {
    return null;
  }

  const extension = paymentPayload.extensions[EIP2612_GAS_SPONSORING.key] as
    | Eip2612GasSponsoringExtension
    | undefined;

  if (!extension?.info) {
    return null;
  }

  const info = extension.info as Record<string, unknown>;

  // Check that the client has populated the required fields
  if (
    !info.from ||
    !info.asset ||
    !info.spender ||
    !info.amount ||
    !info.nonce ||
    !info.deadline ||
    !info.signature ||
    !info.version
  ) {
    return null;
  }

  return info as unknown as Eip2612GasSponsoringInfo;
}

/**
 * Validates that the EIP-2612 gas sponsoring info has valid format.
 *
 * Performs basic validation on the info fields:
 * - Addresses are valid hex (0x + 40 hex chars)
 * - Amount, nonce, deadline are numeric strings
 * - Signature is a hex string
 * - Version is a numeric version string
 *
 * @param info - The EIP-2612 gas sponsoring info to validate
 * @returns True if the info is valid, false otherwise
 */
export function validateEip2612GasSponsoringInfo(info: Eip2612GasSponsoringInfo): boolean {
  const addressPattern = /^0x[a-fA-F0-9]{40}$/;
  const numericPattern = /^[0-9]+$/;
  const hexPattern = /^0x[a-fA-F0-9]+$/;
  const versionPattern = /^[0-9]+(\.[0-9]+)*$/;

  return (
    addressPattern.test(info.from) &&
    addressPattern.test(info.asset) &&
    addressPattern.test(info.spender) &&
    numericPattern.test(info.amount) &&
    numericPattern.test(info.nonce) &&
    numericPattern.test(info.deadline) &&
    hexPattern.test(info.signature) &&
    versionPattern.test(info.version)
  );
}
