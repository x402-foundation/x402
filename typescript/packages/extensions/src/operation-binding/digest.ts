import { canonicalize } from "../offer-receipt/signing";
import type {
  JsonObject,
  JsonValue,
  OperationBindingComponents,
  OperationBindingInfo,
  OperationBindingLogicalInput,
  OperationReceiptPayload,
} from "./types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Operation-binding only supports finite JSON numbers");
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    return value.map(item => normalizeJsonValue(item));
  }

  if (isPlainObject(value)) {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        result[key] = normalizeJsonValue(entry);
      }
    }
    return result;
  }

  throw new Error("Operation-binding only supports JSON-compatible values");
}

function normalizeJsonObject(
  value: Record<string, unknown> | null | undefined,
  fieldName: string,
): JsonObject | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isPlainObject(value)) {
    throw new Error(`${fieldName} must be a JSON object when provided`);
  }

  return normalizeJsonValue(value) as JsonObject;
}

export function createOperationBindingInput(
  binding: OperationBindingInfo,
  components: OperationBindingComponents = {},
): OperationBindingLogicalInput {
  return {
    version: 1,
    transport: binding.transport,
    resourceUrl: binding.resourceUrl,
    method: binding.method.toUpperCase(),
    pathTemplate: binding.pathTemplate,
    operationId: binding.operationId,
    policyVersion: binding.policyVersion,
    pathParams: binding.bindPathParams
      ? normalizeJsonObject(components.pathParams ?? null, "pathParams")
      : null,
    query: binding.bindQuery ? normalizeJsonObject(components.query ?? null, "query") : null,
    body: binding.bindBody ? normalizeJsonValue(components.body ?? null) : null,
  };
}

export function getOperationBindingCanonicalBytes(
  binding: OperationBindingInfo,
  components: OperationBindingComponents = {},
): Uint8Array {
  const input = createOperationBindingInput(binding, components);
  return new TextEncoder().encode(canonicalize(input));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hashBuffer = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(hashBuffer))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function computeOperationDigest(
  binding: OperationBindingInfo,
  components: OperationBindingComponents = {},
): Promise<string> {
  const bytes = getOperationBindingCanonicalBytes(binding, components);
  return sha256Hex(bytes);
}

export async function verifyOperationReceiptMatchesInput(
  payload: OperationReceiptPayload,
  components: OperationBindingComponents = {},
): Promise<{
  matches: boolean;
  expectedDigest: string;
  actualDigest: string;
}> {
  const expectedDigest = await computeOperationDigest(
    {
      transport: payload.transport,
      resourceUrl: payload.resourceUrl,
      method: payload.method,
      pathTemplate: payload.pathTemplate,
      operationId: payload.operationId,
      policyVersion: payload.policyVersion,
      canonicalization: payload.canonicalization,
      digestAlgorithm: payload.digestAlgorithm,
      bindPathParams: payload.bindPathParams,
      bindQuery: payload.bindQuery,
      bindBody: payload.bindBody,
    },
    components,
  );

  return {
    matches: expectedDigest === payload.operationDigest,
    expectedDigest,
    actualDigest: payload.operationDigest,
  };
}
