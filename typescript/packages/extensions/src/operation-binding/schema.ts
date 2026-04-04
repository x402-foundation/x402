import type { OperationBindingSchema } from "./types";

export const operationBindingSchema: OperationBindingSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    transport: { type: "string", const: "http" },
    resourceUrl: { type: "string", format: "uri" },
    method: { type: "string" },
    pathTemplate: { type: "string" },
    operationId: { type: "string" },
    policyVersion: { type: "string" },
    canonicalization: { type: "string", const: "rfc8785-jcs" },
    digestAlgorithm: { type: "string", const: "sha-256" },
    bindPathParams: { type: "boolean" },
    bindQuery: { type: "boolean" },
    bindBody: { type: "boolean" },
  },
  required: [
    "transport",
    "resourceUrl",
    "method",
    "pathTemplate",
    "operationId",
    "policyVersion",
    "canonicalization",
    "digestAlgorithm",
    "bindPathParams",
    "bindQuery",
    "bindBody",
  ],
  additionalProperties: false,
};
