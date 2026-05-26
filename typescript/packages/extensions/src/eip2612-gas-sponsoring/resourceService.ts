/**
 * Resource Service functions for declaring the EIP-2612 Gas Sponsoring extension.
 *
 * These functions help servers declare support for EIP-2612 gasless Permit2 approvals
 * in the PaymentRequired response extensions.
 */

import { EIP2612_GAS_SPONSORING, type Eip2612GasSponsoringExtension } from "./types";

/**
 * The JSON Schema for the EIP-2612 gas sponsoring extension info.
 * Matches the schema defined in the spec.
 */
const eip2612GasSponsoringSchema: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    from: {
      type: "string",
      pattern: "^0x[a-fA-F0-9]{40}$",
      description: "The address of the sender.",
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
      description: "The amount to approve (uint256). Typically MaxUint.",
    },
    nonce: {
      type: "string",
      pattern: "^[0-9]+$",
      description: "The current nonce of the sender.",
    },
    deadline: {
      type: "string",
      pattern: "^[0-9]+$",
      description: "The timestamp at which the signature expires.",
    },
    signature: {
      type: "string",
      pattern: "^0x[a-fA-F0-9]+$",
      description: "The 65-byte concatenated signature (r, s, v) as a hex string.",
    },
    version: {
      type: "string",
      pattern: "^[0-9]+(\\.[0-9]+)*$",
      description: "Schema version identifier.",
    },
  },
  required: ["from", "asset", "spender", "amount", "nonce", "deadline", "signature", "version"],
};

/**
 * Declares the EIP-2612 gas sponsoring extension for inclusion in
 * PaymentRequired.extensions.
 *
 * The server advertises that it (or its facilitator) supports EIP-2612
 * gasless Permit2 approval. The client will populate the info with the
 * actual permit signature data.
 *
 * @returns An object keyed by the extension identifier containing the extension declaration
 *
 * @example
 * ```typescript
 * import { declareEip2612GasSponsoringExtension } from '@x402/extensions';
 *
 * const routes = [
 *   {
 *     path: "/api/data",
 *     price: "$0.01",
 *     extensions: {
 *       ...declareEip2612GasSponsoringExtension(),
 *     },
 *   },
 * ];
 * ```
 */
export function declareEip2612GasSponsoringExtension(): Record<
  string,
  Eip2612GasSponsoringExtension
> {
  const key = EIP2612_GAS_SPONSORING.key;
  return {
    [key]: {
      info: {
        description:
          "The facilitator accepts EIP-2612 gasless Permit to `Permit2` canonical contract.",
        version: "1",
      },
      schema: eip2612GasSponsoringSchema,
    },
  };
}
