/**
 * Resource Service functions for declaring the Swap Settlement extension.
 *
 * These functions help servers (whose facilitator supports swap settlement)
 * advertise the extension in the PaymentRequired response extensions. The
 * 402 response carries discovery data only; live quotes are obtained from
 * `quoteUrl`.
 */

import type { ResourceServerExtension } from "@x402/core/types";
import {
  SWAP_SETTLEMENT_KEY,
  type SwapAuthorizationMethod,
  type SwapSettlementDeclareConfig,
  type SwapSettlementExtension,
} from "./types";

const ALL_AUTHORIZATION_METHODS: SwapAuthorizationMethod[] = [
  "eip3009",
  "permit2",
  "eip2612",
  "allowance",
];

const witnessSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    quoteIdHash: { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" },
    requirementsHash: { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" },
    payTo: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
    outputAsset: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
    outputAmount: { type: "string", pattern: "^[0-9]+$" },
  },
  required: ["quoteIdHash", "requirementsHash", "payTo", "outputAsset", "outputAmount"],
};

/**
 * The JSON Schema for the client-populated swap settlement payload info.
 * Matches the shape defined in the spec.
 */
const swapSettlementSchema: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    version: {
      type: "string",
      const: "1",
      description: "Extension version.",
    },
    quoteId: {
      type: "string",
      minLength: 1,
      description: "Opaque, single-use quote identifier from the quote endpoint.",
    },
    inputAsset: {
      type: "string",
      pattern: "^0x[a-fA-F0-9]{40}$",
      description: "The input asset the payer holds and authorizes.",
    },
    method: {
      type: "string",
      enum: ["eip3009", "permit2", "eip2612", "allowance"],
      description: "The chosen authorization method.",
    },
    permit2Authorization: {
      type: "object",
      description: "Signed Permit2 PermitWitnessTransferFrom authorization.",
      properties: {
        permitted: {
          type: "object",
          properties: {
            token: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
            amount: { type: "string", pattern: "^[0-9]+$" },
          },
          required: ["token", "amount"],
        },
        from: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
        spender: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
        nonce: { type: "string", pattern: "^[0-9]+$" },
        deadline: { type: "string", pattern: "^[0-9]+$" },
        witness: witnessSchema,
        signature: { type: "string", pattern: "^0x[a-fA-F0-9]+$" },
      },
      required: ["permitted", "from", "spender", "nonce", "deadline", "witness", "signature"],
    },
    eip3009Authorization: {
      type: "object",
      description: "Signed EIP-3009 ReceiveWithAuthorization authorization.",
      properties: {
        from: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
        to: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
        value: { type: "string", pattern: "^[0-9]+$" },
        validAfter: { type: "string", pattern: "^[0-9]+$" },
        validBefore: { type: "string", pattern: "^[0-9]+$" },
        nonce: { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" },
        signature: { type: "string", pattern: "^0x[a-fA-F0-9]+$" },
      },
      required: ["from", "to", "value", "validAfter", "validBefore", "nonce", "signature"],
    },
    eip2612Authorization: {
      type: "object",
      description: "Signed EIP-2612 permit (gasless approval bootstrap).",
      properties: {
        owner: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
        spender: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
        value: { type: "string", pattern: "^[0-9]+$" },
        nonce: { type: "string", pattern: "^[0-9]+$" },
        deadline: { type: "string", pattern: "^[0-9]+$" },
        signature: { type: "string", pattern: "^0x[a-fA-F0-9]+$" },
      },
      required: ["owner", "spender", "value", "nonce", "deadline", "signature"],
    },
    allowanceAuthorization: {
      type: "object",
      description: "Signed EIP-712 SwapSettlementIntent for a pre-existing allowance.",
      properties: {
        from: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
        maxAmountIn: { type: "string", pattern: "^[0-9]+$" },
        deadline: { type: "string", pattern: "^[0-9]+$" },
        signature: { type: "string", pattern: "^0x[a-fA-F0-9]+$" },
      },
      required: ["from", "maxAmountIn", "deadline", "signature"],
    },
  },
  required: ["version", "quoteId", "inputAsset", "method"],
};

/**
 * Declares the swap settlement extension for inclusion in
 * PaymentRequired.extensions.
 *
 * The server advertises that its facilitator supports token-agnostic
 * payments: the payer may satisfy the requirements holding a different
 * same-chain asset, which the facilitator swaps and settles atomically.
 * The client obtains live quotes from `quoteUrl` and populates the payload
 * info with the chosen quote and signed authorization.
 *
 * @param config - Discovery data: quote endpoint, networks, accepted methods
 * @returns An object keyed by the extension identifier containing the extension declaration
 *
 * @example
 * ```typescript
 * import { declareSwapSettlementExtension } from '@x402/extensions';
 *
 * const routes = [
 *   {
 *     path: "/api/data",
 *     price: "$0.01",
 *     extensions: {
 *       ...declareSwapSettlementExtension({
 *         quoteUrl: "https://facilitator.example.com/x402/swap/quote",
 *         networks: ["eip155:8453"],
 *       }),
 *     },
 *   },
 * ];
 * ```
 */
export function declareSwapSettlementExtension(
  config: SwapSettlementDeclareConfig,
): Record<string, SwapSettlementExtension> {
  return {
    [SWAP_SETTLEMENT_KEY]: {
      info: {
        version: "1",
        description:
          config.description ??
          "Pay in a different same-chain asset; the facilitator swaps and settles atomically.",
        quoteUrl: config.quoteUrl,
        networks: config.networks,
        authorizationMethods: config.authorizationMethods ?? ALL_AUTHORIZATION_METHODS,
        ...(config.inputAssetsUrl !== undefined && { inputAssetsUrl: config.inputAssetsUrl }),
      },
      schema: swapSettlementSchema,
    },
  };
}

/**
 * Resource-server extension registration for swap settlement.
 *
 * The 402 response advertises discovery data (quoteUrl, networks, methods), but the
 * client's payment payload replaces that info with its payment data (quoteId and a signed
 * authorization) per the spec — it is not an echo. Registering this extension marks every
 * discovery field as dynamic so the core server's extension echo validation does not
 * reject swap payments with `extension_echo_mismatch`.
 *
 * @example
 * ```typescript
 * new x402ResourceServer(facilitatorClient)
 *   .register("eip155:8453", new ExactEvmScheme())
 *   .registerExtension(swapSettlementResourceServerExtension);
 * ```
 */
export const swapSettlementResourceServerExtension: ResourceServerExtension = {
  key: SWAP_SETTLEMENT_KEY,
  dynamicInfoFields: [
    "description",
    "quoteUrl",
    "networks",
    "authorizationMethods",
    "inputAssetsUrl",
  ],
};
