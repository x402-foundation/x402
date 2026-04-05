import type { ScenarioResult, TestEndpoint, TestConfig } from "../src/types";

const OPERATION_BINDING = "operation-binding";
const OPERATION_BINDING_PATH = "/exact/evm/operation-binding";
const OPERATION_BINDING_OPERATION_ID = "exact.evm.operationBinding";
const OPERATION_BINDING_POLICY_VERSION = "2026-04-04";

interface OperationBindingValidationResult {
  success: boolean;
  error?: string;
}

/**
 * Check whether the scenario endpoint declares the operation-binding extension.
 *
 * @param endpoint - Endpoint metadata from the E2E scenario.
 * @returns `true` when the endpoint opts into operation-binding validation.
 */
function endpointRequiresOperationBinding(endpoint: TestEndpoint): boolean {
  return endpoint.extensions?.includes(OPERATION_BINDING) ?? false;
}

/**
 * Check whether the client explicitly supports surfacing operation-binding details.
 *
 * @param clientConfig - E2E client configuration metadata.
 * @returns `true` when the client can expose PaymentRequired extension data.
 */
export function clientSupportsOperationBinding(
  clientConfig: TestConfig,
): boolean {
  return clientConfig.extensions?.includes(OPERATION_BINDING) ?? false;
}

/**
 * Check whether a scenario should run operation-binding validation.
 *
 * @param selectedExtensions - Extension output flags selected for the run.
 * @param endpoint - Endpoint metadata from the scenario.
 * @param clientConfig - Client metadata from the scenario.
 * @returns `true` when operation-binding should be validated for the scenario.
 */
export function shouldValidateOperationBinding(
  selectedExtensions: string[] | undefined,
  endpoint: TestEndpoint,
  clientConfig: TestConfig,
): boolean {
  if (!selectedExtensions?.includes(OPERATION_BINDING)) {
    return false;
  }

  if (!endpointRequiresOperationBinding(endpoint)) {
    return false;
  }

  return clientSupportsOperationBinding(clientConfig);
}

/**
 * Validate the operation-binding declaration captured from a live PaymentRequired response.
 *
 * @param result - Client result containing the captured PaymentRequired payload.
 * @param endpoint - Endpoint metadata from the scenario.
 * @returns Validation result.
 */
export function validateOperationBindingResult(
  result: ScenarioResult,
  endpoint: TestEndpoint,
): OperationBindingValidationResult {
  const paymentRequired = result.payment_required;
  if (!paymentRequired || typeof paymentRequired !== "object") {
    return {
      success: false,
      error:
        "Client did not capture the PaymentRequired payload for operation-binding validation.",
    };
  }

  const extensions = (
    paymentRequired as { extensions?: Record<string, unknown> }
  ).extensions;
  const extensionValue = extensions?.[OPERATION_BINDING];
  if (!extensionValue || typeof extensionValue !== "object") {
    return {
      success: false,
      error:
        "PaymentRequired response is missing the operation-binding extension.",
    };
  }

  const info = (extensionValue as { info?: Record<string, unknown> }).info;
  if (!info || typeof info !== "object") {
    return {
      success: false,
      error: "Operation-binding extension is missing its info payload.",
    };
  }

  const expectedPath = endpoint.path.split("?")[0];

  const expectedFields: Array<[keyof typeof info, unknown]> = [
    ["transport", "http"],
    ["method", endpoint.method],
    ["pathTemplate", expectedPath],
    ["operationId", OPERATION_BINDING_OPERATION_ID],
    ["policyVersion", OPERATION_BINDING_POLICY_VERSION],
    ["canonicalization", "rfc8785-jcs"],
    ["digestAlgorithm", "sha-256"],
    ["bindPathParams", true],
    ["bindQuery", true],
    ["bindBody", false],
  ];

  for (const [field, expectedValue] of expectedFields) {
    if (info[field] !== expectedValue) {
      return {
        success: false,
        error: `Operation-binding field ${String(field)} was ${JSON.stringify(info[field])}, expected ${JSON.stringify(expectedValue)}.`,
      };
    }
  }

  const resourceUrl = info.resourceUrl;
  if (typeof resourceUrl !== "string") {
    return {
      success: false,
      error: "Operation-binding resourceUrl is missing or not a string.",
    };
  }

  const url = new URL(resourceUrl);
  if (url.pathname !== expectedPath) {
    return {
      success: false,
      error: `Operation-binding resourceUrl pathname was ${url.pathname}, expected ${expectedPath}.`,
    };
  }

  if (expectedPath === OPERATION_BINDING_PATH) {
    if (
      url.searchParams.get("units") !== "metric" ||
      url.searchParams.get("lang") !== "en"
    ) {
      return {
        success: false,
        error:
          "Operation-binding resourceUrl did not preserve the expected query parameters.",
      };
    }
  }

  return { success: true };
}
