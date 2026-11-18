/**
 * HTTP resource service functions for creating Bazaar discovery extensions
 */

import type {
  QueryDiscoveryExtension,
  BodyDiscoveryExtension,
  DeclareQueryDiscoveryExtensionConfig,
  DeclareBodyDiscoveryExtensionConfig,
} from "./types";

/**
 * Create a query discovery extension (GET, HEAD, DELETE)
 *
 * @param root0 - Configuration object for query discovery extension
 * @param root0.method - HTTP method (GET, HEAD, DELETE)
 * @param root0.input - Query parameters
 * @param root0.inputSchema - JSON schema for query parameters
 * @param root0.output - Output specification with example
 * @param root0.pathParams - Concrete path parameter values extracted from the request
 * @param root0.pathParamsSchema - JSON schema for path parameters
 * @returns QueryDiscoveryExtension with info and schema
 */
export function createQueryDiscoveryExtension({
  method,
  input = {},
  inputSchema = { properties: {} },
  pathParams,
  pathParamsSchema,
  output,
}: DeclareQueryDiscoveryExtensionConfig): QueryDiscoveryExtension {
  return {
    info: {
      input: {
        type: "http" as const,
        ...(method ? { method } : {}),
        ...(input ? { queryParams: input } : {}),
        ...(pathParams ? { pathParams } : {}),
      },
      ...(output?.example
        ? {
            output: {
              type: "json",
              example: output.example,
            },
          }
        : {}),
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "http",
            },
            method: {
              type: "string",
              enum: ["GET", "HEAD", "DELETE"],
            },
            ...(inputSchema
              ? {
                  queryParams: {
                    type: "object" as const,
                    ...(typeof inputSchema === "object" ? inputSchema : {}),
                  },
                }
              : {}),
            ...(pathParamsSchema
              ? {
                  pathParams: {
                    type: "object" as const,
                    ...(typeof pathParamsSchema === "object" ? pathParamsSchema : {}),
                  },
                }
              : {}),
          },
          required: ["type", "method"] as ("type" | "method")[],
          // pathParams are not declared here at schema build time --
          // the server extension's enrichDeclaration adds them to both info and schema
          // atomically at request time, keeping data and schema consistent.
          additionalProperties: false,
        },
        ...(output?.example
          ? {
              output: {
                type: "object" as const,
                properties: {
                  type: {
                    type: "string" as const,
                  },
                  example: {
                    type: "object" as const,
                    ...(output.schema && typeof output.schema === "object" ? output.schema : {}),
                  },
                },
                required: ["type"] as const,
              },
            }
          : {}),
      },
      required: ["input"],
    },
  };
}

/**
 * Create a body discovery extension (POST, PUT, PATCH)
 *
 * @param root0 - Configuration object for body discovery extension
 * @param root0.method - HTTP method (POST, PUT, PATCH)
 * @param root0.input - Request body specification
 * @param root0.inputSchema - JSON schema for request body
 * @param root0.bodyType - Content type of body (json, form-data, text)
 * @param root0.output - Output specification with example
 * @param root0.pathParams - Concrete path parameter values extracted from the request
 * @param root0.pathParamsSchema - JSON schema for path parameters
 * @returns BodyDiscoveryExtension with info and schema
 */
export function createBodyDiscoveryExtension({
  method,
  input = {},
  inputSchema = { properties: {} },
  pathParams,
  pathParamsSchema,
  bodyType,
  output,
}: DeclareBodyDiscoveryExtensionConfig): BodyDiscoveryExtension {
  return {
    info: {
      input: {
        type: "http" as const,
        ...(method ? { method } : {}),
        bodyType,
        body: input,
        ...(pathParams ? { pathParams } : {}),
      },
      ...(output?.example
        ? {
            output: {
              type: "json",
              example: output.example,
            },
          }
        : {}),
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "http",
            },
            method: {
              type: "string",
              enum: ["POST", "PUT", "PATCH"],
            },
            bodyType: {
              type: "string",
              enum: ["json", "form-data", "text"],
            },
            body: inputSchema,
            ...(pathParamsSchema
              ? {
                  pathParams: {
                    type: "object" as const,
                    ...(typeof pathParamsSchema === "object" ? pathParamsSchema : {}),
                  },
                }
              : {}),
          },
          required: ["type", "method", "bodyType", "body"] as (
            | "type"
            | "method"
            | "bodyType"
            | "body"
          )[],
          // pathParams are not declared here at schema build time --
          // the server extension's enrichDeclaration adds them to both info and schema
          // atomically at request time, keeping data and schema consistent.
          additionalProperties: false,
        },
        ...(output?.example
          ? {
              output: {
                type: "object" as const,
                properties: {
                  type: {
                    type: "string" as const,
                  },
                  example: {
                    type: "object" as const,
                    ...(output.schema && typeof output.schema === "object" ? output.schema : {}),
                  },
                },
                required: ["type"] as const,
              },
            }
          : {}),
      },
      required: ["input"],
    },
  };
}
