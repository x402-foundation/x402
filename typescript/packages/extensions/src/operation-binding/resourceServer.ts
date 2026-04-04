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

function normalizePathTemplate(routePattern: string): string {
  return routePattern.replace(BRACKET_PARAM_REGEX_ALL, ":$1");
}

function isHTTPTransportContext(value: unknown): value is HTTPTransportContext {
  return value !== null && typeof value === "object" && "request" in value;
}

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

