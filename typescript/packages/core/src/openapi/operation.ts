/**
 * OpenAPI operation builder: constructs typed Operation objects from route configs.
 */
import type { RouteConfig } from "../http/x402HTTPResourceServer";
import type { Operation, Parameter, JsonSchemaProperty } from "./schemas";
import type { BazaarSchemas } from "./bazaar";
import { buildPaymentInfo } from "./payment";

/**
 * Build an OpenAPI operation from a route config, path params, and bazaar schemas.
 */
export function buildOperation(
  routeConfig: RouteConfig,
  pathParams: string[],
  bazaar: BazaarSchemas,
): Operation {
  const parameters = buildParameters(pathParams, bazaar);

  const operation: Operation = {
    "x-payment-info": buildPaymentInfo(routeConfig.accepts),
    responses: {
      "200": {
        description: "Successful response",
        ...(bazaar.outputSchema
          ? {
              content: {
                [routeConfig.mimeType || "application/json"]: {
                  schema: bazaar.outputSchema,
                },
              },
            }
          : {}),
      },
      "402": {
        description: "Payment Required",
      },
    },
  };

  if (routeConfig.description) {
    operation.summary = routeConfig.description;
  }

  if (parameters.length > 0) {
    operation.parameters = parameters;
  }

  return operation;
}

/**
 * Build OpenAPI parameters from path params and bazaar input schemas.
 */
function buildParameters(pathParams: string[], bazaar: BazaarSchemas): Parameter[] {
  const parameters: Parameter[] = [];

  // Path parameters
  for (const name of pathParams) {
    const paramSchema = getPathParamSchema(bazaar.pathParamsSchema, name);

    parameters.push({
      in: "path",
      name,
      required: true,
      schema: paramSchema || { type: "string" },
    });
  }

  // Query parameters from bazaar input schema
  if (bazaar.inputSchema?.properties) {
    for (const [name, schema] of Object.entries(bazaar.inputSchema.properties)) {
      parameters.push({
        in: "query",
        name,
        required: false,
        schema: schema || { type: "string" },
      });
    }
  }

  return parameters;
}

/**
 * Look up a specific path parameter's schema from the bazaar pathParamsSchema.
 */
function getPathParamSchema(
  pathParamsSchema: JsonSchemaProperty | undefined,
  paramName: string,
): JsonSchemaProperty | undefined {
  if (!pathParamsSchema?.properties) return undefined;
  return pathParamsSchema.properties[paramName];
}
