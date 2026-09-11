/**
 * Authorization Evidence Extension Schema
 *
 * JSON Schema for the extension info payload advertised in PaymentRequired
 * responses and echoed by v2 clients.
 */

import { AUTHORIZATION_EVIDENCE_PROFILE } from "./types";

/** JSON Schema (Draft 2020-12) for the authorization-evidence info payload. */
export const authorizationEvidenceSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Authorization Evidence Extension",
  type: "object",
  properties: {
    profile: { const: AUTHORIZATION_EVIDENCE_PROFILE },
    nonce: { type: "string", minLength: 1 },
    expiresAt: { type: "integer" },
    evidence: { type: "string", minLength: 1 },
  },
  required: ["profile"],
  additionalProperties: true,
} as const;
