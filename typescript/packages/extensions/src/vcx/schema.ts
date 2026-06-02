/**
 * Copyright 2026 PayPal Holdings, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * JSON Schema for the VCX identity envelope as v0.2+ accepts it.
 *
 * Emitted with the extension declaration so clients and external tooling
 * can validate envelopes against the contract the verifier enforces.
 *
 * The schema mirrors the v1.0 spec MUSTs: `credentialFormat` (§6.1) is an
 * enum of `{jwt-vc, sd-jwt-vc}`; `delegationProofFormat` (§6.2 / §10) is
 * the literal `vc-embedded` in v1; `vcxPresent` (§6) is the literal
 * boolean `true`.
 */
export interface VCXEnvelopeSchema {
  $schema: string;
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
}

export function buildVCXEnvelopeSchema(): VCXEnvelopeSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      version: { type: "string", const: "1.0" },
      protocol: { type: "string", const: "x402-vcx-v1" },
      transactionId: { type: "string", format: "uuid" },
      vcxPresent: { type: "boolean", const: true },
      principal: {
        type: "object",
        properties: {
          credentialFormat: { type: "string", enum: ["jwt-vc", "sd-jwt-vc"] },
          credentialJwt: { type: "string" },
          did: { type: "string" },
          disclosed: { type: "object" },
        },
        required: ["credentialFormat", "credentialJwt", "did", "disclosed"],
      },
      agent: {
        type: "object",
        properties: {
          did: { type: "string" },
          name: { type: "string" },
          delegationProofFormat: { type: "string", const: "vc-embedded" },
          delegationProof: { type: "string" },
        },
        required: ["did", "name", "delegationProofFormat", "delegationProof"],
      },
      paymentSource: {
        type: "object",
        properties: {
          accountId: { type: "string" },
          sourceId: { type: "string" },
          network: { type: "string" },
          asset: { type: "string" },
        },
        required: ["accountId", "sourceId", "network"],
      },
    },
    required: [
      "version",
      "protocol",
      "transactionId",
      "vcxPresent",
      "principal",
      "agent",
      "paymentSource",
    ],
  };
}
