/**
 * JSON Schema builder for SIWX extension
 *
 * Per CHANGELOG-v2.md lines 276-292
 */

import type { SIWxExtensionSchema } from "./types";

/**
 * Build JSON Schema for SIWX extension validation.
 * This schema validates the client proof payload structure.
 *
 * @returns JSON Schema for validating SIWX client payloads
 */
export function buildSIWxSchema(): SIWxExtensionSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      domain: { type: "string" },
      address: { type: "string" },
      statement: { type: "string" },
      uri: { type: "string", format: "uri" },
      version: { type: "string" },
      chainId: { type: "string" },
      type: { type: "string" },
      nonce: { type: "string" },
      issuedAt: { type: "string", format: "date-time" },
      expirationTime: { type: "string", format: "date-time" },
      notBefore: { type: "string", format: "date-time" },
      requestId: { type: "string" },
      resources: { type: "array", items: { type: "string", format: "uri" } },
      signature: { type: "string" },
    },
    required: [
      "domain",
      "address",
      "uri",
      "version",
      "chainId",
      "type",
      "nonce",
      "issuedAt",
      "signature",
    ],
  };
}
