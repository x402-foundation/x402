import type { PaymentRequiredContext, ResourceServerExtension } from "@x402/core/types";
import type { HTTPTransportContext } from "@x402/core/http";
import { OPERATION_BINDING } from "./types";
import type {
  OperationBindingDeclaration,
  OperationBindingExtension,
  OperationBindingInfo,
} from "./types";
import { operationBindingSchema } from "./schema";

const BRACKET_PARAM_REGEX_ALL = /\[([^\]]+)\]/g;

/**
 * Convert framework-style bracket params into the colon-prefixed form used by the spec.
 *
 * @param routePattern - Route pattern reported by the HTTP adapter.
 * @returns A normalized path template string.
 */
function normalizePathTemplate(routePattern: string): string {
  return routePattern.replace(BRACKET_PARAM_REGEX_ALL, ":$1");
}

/**
 * Check whether a payment-required context is backed by the HTTP transport integration.
 *
 * @param value - Candidate transport context.
 * @returns `true` when the context exposes an HTTP request object.
 */
function isHTTPTransportContext(value: unknown): value is HTTPTransportContext {
  return value !== null && typeof value === "object" && "request" in value;
}

/**
 * Resolve a declaration plus HTTP request context into concrete binding metadata.
 *
 * @param declaration - Static operation-binding declaration configured by the server.
 * @param context - Runtime payment-required context for the current request.
 * @returns Fully populated binding metadata, or `undefined` when HTTP details are unavailable.
 */
function toOperationBindingInfo(
  declaration: OperationBindingDeclaration,
  context: PaymentRequiredContext,
): OperationBindingInfo | undefined {
  if (!isHTTPTransportContext(context.transportContext)) {
    return undefined;
  }

  const request = context.transportContext.request;
  const resourceUrl = context.paymentRequiredResponse.resource?.url ?? context.resourceInfo.url;
  const method = request.method?.toUpperCase();
  const pathTemplate = request.routePattern
    ? normalizePathTemplate(request.routePattern)
    : request.adapter.getPath();

  if (!resourceUrl || !method || !pathTemplate) {
    return undefined;
  }

  return {
    transport: "http",
    resourceUrl,
    method,
    pathTemplate,
    operationId: declaration.operationId,
    policyVersion: declaration.policyVersion,
    canonicalization: "rfc8785-jcs",
    digestAlgorithm: "sha-256",
    bindPathParams: declaration.bindPathParams ?? true,
    bindQuery: declaration.bindQuery ?? true,
    bindBody: declaration.bindBody ?? true,
  };
}

/**
 * Normalize a server-side declaration so omitted binding flags use the spec defaults.
 *
 * @param declaration - Static declaration supplied by application code.
 * @returns Declaration with default binding flags filled in.
 */
export function declareOperationBindingExtension(
  declaration: OperationBindingDeclaration,
): OperationBindingDeclaration {
  return {
    operationId: declaration.operationId,
    policyVersion: declaration.policyVersion,
    bindPathParams: declaration.bindPathParams ?? true,
    bindQuery: declaration.bindQuery ?? true,
    bindBody: declaration.bindBody ?? true,
  };
}

export const operationBindingResourceServerExtension: ResourceServerExtension = {
  key: OPERATION_BINDING,

  enrichPaymentRequiredResponse: async (
    declaration: unknown,
    context: PaymentRequiredContext,
  ): Promise<OperationBindingExtension | undefined> => {
    const info = toOperationBindingInfo(declaration as OperationBindingDeclaration, context);
    if (!info) {
      return undefined;
    }

    return {
      info,
      schema: operationBindingSchema,
    };
  },
};
