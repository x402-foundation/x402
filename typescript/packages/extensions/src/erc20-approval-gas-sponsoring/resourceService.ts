/**
 * Resource Service functions for declaring the ERC-20 Approval Gas Sponsoring extension.
 *
 * These functions help servers declare support for ERC-20 approval gas sponsoring
 * in the PaymentRequired response extensions. Use this for tokens that do NOT
 * implement EIP-2612 (generic ERC-20 tokens).
 */

import {
  ERC20_APPROVAL_GAS_SPONSORING,
  ERC20_APPROVAL_GAS_SPONSORING_VERSION,
  type Erc20ApprovalGasSponsoringExtension,
} from "./types";

/**
 * The JSON Schema for the ERC-20 approval gas sponsoring extension info.
 * Matches the schema defined in the spec.
 */
export const erc20ApprovalGasSponsoringSchema: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    from: {
      type: "string",
      pattern: "^0x[a-fA-F0-9]{40}$",
      description: "The address of the sender (token owner).",
    },
    asset: {
      type: "string",
      pattern: "^0x[a-fA-F0-9]{40}$",
      description: "The address of the ERC-20 token contract.",
    },
    spender: {
      type: "string",
      pattern: "^0x[a-fA-F0-9]{40}$",
      description: "The address of the spender (Canonical Permit2).",
    },
    amount: {
      type: "string",
      pattern: "^[0-9]+$",
      description: "The amount approved (uint256). Always MaxUint256.",
    },
    signedTransaction: {
      type: "string",
      pattern: "^0x[a-fA-F0-9]+$",
      description: "The RLP-encoded signed EIP-1559 transaction as a hex string.",
    },
    version: {
      type: "string",
      pattern: "^[0-9]+(\\.[0-9]+)*$",
      description: "Schema version identifier.",
    },
  },
  required: ["from", "asset", "spender", "amount", "signedTransaction", "version"],
};

/**
 * Declares the ERC-20 approval gas sponsoring extension for inclusion in
 * PaymentRequired.extensions.
 *
 * The server advertises that it (or its facilitator) supports broadcasting
 * a pre-signed `approve(Permit2, MaxUint256)` transaction on the client's behalf.
 * Use this for tokens that do NOT implement EIP-2612.
 *
 * @returns An object keyed by the extension identifier containing the extension declaration
 *
 * @example
 * ```typescript
 * import { declareErc20ApprovalGasSponsoringExtension } from '@x402/extensions';
 *
 * const routes = [
 *   {
 *     path: "/api/data",
 *     price: { amount: "1000", asset: "0x...", extra: { assetTransferMethod: "permit2" } },
 *     extensions: {
 *       ...declareErc20ApprovalGasSponsoringExtension(),
 *     },
 *   },
 * ];
 * ```
 */
export function declareErc20ApprovalGasSponsoringExtension(): Record<
  string,
  Erc20ApprovalGasSponsoringExtension
> {
  const key = ERC20_APPROVAL_GAS_SPONSORING.key;
  return {
    [key]: {
      info: {
        description:
          "The facilitator broadcasts a pre-signed ERC-20 approve() transaction to grant Permit2 allowance.",
        version: ERC20_APPROVAL_GAS_SPONSORING_VERSION,
      },
      schema: erc20ApprovalGasSponsoringSchema,
    },
  };
}
