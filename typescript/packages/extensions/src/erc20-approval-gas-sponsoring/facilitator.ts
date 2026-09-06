/**
 * Facilitator functions for extracting and validating ERC-20 Approval Gas Sponsoring
 * extension data.
 *
 * These functions help facilitators extract the pre-signed approve() transaction
 * from payment payloads and validate it before broadcasting and settling.
 */

import Ajv from "ajv/dist/2020.js";
import type { PaymentPayload } from "@x402/core/types";
import {
  ERC20_APPROVAL_GAS_SPONSORING,
  type Erc20ApprovalGasSponsoringInfo,
  type Erc20ApprovalGasSponsoringExtension,
} from "./types";
import { erc20ApprovalGasSponsoringSchema } from "./resourceService";

/**
 * Extracts the ERC-20 approval gas sponsoring info from a payment payload's extensions.
 *
 * Performs structural extraction only — checks that the extension is present and
 * contains all required fields. Does NOT validate field formats (use
 * validateErc20ApprovalGasSponsoringInfo for that).
 *
 * @param paymentPayload - The payment payload to extract from
 * @returns The ERC-20 approval gas sponsoring info, or null if not present
 */
export function extractErc20ApprovalGasSponsoringInfo(
  paymentPayload: PaymentPayload,
): Erc20ApprovalGasSponsoringInfo | null {
  if (!paymentPayload.extensions) {
    return null;
  }

  const extension = paymentPayload.extensions[ERC20_APPROVAL_GAS_SPONSORING.key] as
    | Erc20ApprovalGasSponsoringExtension
    | undefined;

  if (!extension?.info) {
    return null;
  }

  const info = extension.info as Record<string, unknown>;

  if (
    !info.from ||
    !info.asset ||
    !info.spender ||
    !info.amount ||
    !info.signedTransaction ||
    !info.version
  ) {
    return null;
  }

  return info as unknown as Erc20ApprovalGasSponsoringInfo;
}

/**
 * Validates that the ERC-20 approval gas sponsoring info has valid format.
 *
 * Validates the info against the canonical JSON Schema, checking:
 * - All required fields are present
 * - Addresses are valid hex (0x + 40 hex chars)
 * - Amount is a numeric string
 * - signedTransaction is a hex string
 * - Version is a numeric version string
 *
 * @param info - The ERC-20 approval gas sponsoring info to validate
 * @returns True if the info is valid, false otherwise
 */
export function validateErc20ApprovalGasSponsoringInfo(
  info: Erc20ApprovalGasSponsoringInfo,
): boolean {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(erc20ApprovalGasSponsoringSchema);
  return validate(info) as boolean;
}
