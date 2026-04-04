import { canonicalize } from "../offer-receipt/signing";
import type {
  JsonObject,
  JsonValue,
  OperationBindingComponents,
  OperationBindingInfo,
  OperationBindingLogicalInput,
  OperationReceiptPayload,
} from "./types";

/**
 * Check whether a value can be normalized as a JSON object.
 *
 * @param value - Candidate value from caller input.
 * @returns `true` when the value is a non-array object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize arbitrary input into the JSON subset supported by operation binding.
 *
 * @param value - Candidate JSON-compatible value.
 * @returns A normalized JSON value with `undefined` removed and `-0` rewritten to `0`.
 */
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

/**
 * Normalize a top-level object field used in the logical binding input.
 *
 * @param value - Candidate object value for the field.
 * @param fieldName - Human-readable field name for validation errors.
 * @returns A normalized JSON object or `null` when omitted.
 */
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

/**
 * Build the logical input that is hashed for an operation-bound receipt.
 *
 * @param binding - Static and enriched binding metadata for the operation.
 * @param components - Validated request components that may be bound into the digest.
 * @returns The normalized logical input object used for canonicalization.
 */
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

/**
 * Canonicalize an operation-binding input and return its UTF-8 bytes.
 *
 * @param binding - Static and enriched binding metadata for the operation.
 * @param components - Validated request components that may be bound into the digest.
 * @returns UTF-8 bytes of the canonicalized logical input.
 */
export function getOperationBindingCanonicalBytes(
  binding: OperationBindingInfo,
  components: OperationBindingComponents = {},
): Uint8Array {
  const input = createOperationBindingInput(binding, components);
  return new TextEncoder().encode(canonicalize(input));
}

/**
 * Compute a SHA-256 digest and encode it as lowercase hexadecimal.
 *
 * @param bytes - Canonical bytes to hash.
 * @returns Lowercase hexadecimal digest output.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hashBuffer = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(hashBuffer))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute the operation digest for a binding plus validated request components.
 *
 * @param binding - Static and enriched binding metadata for the operation.
 * @param components - Validated request components that may be bound into the digest.
 * @returns Lowercase hexadecimal digest for the canonical logical input.
 */
export async function computeOperationDigest(
  binding: OperationBindingInfo,
  components: OperationBindingComponents = {},
): Promise<string> {
  const bytes = getOperationBindingCanonicalBytes(binding, components);
  return sha256Hex(bytes);
}

/**
 * Recompute the digest for a request and compare it against a signed receipt payload.
 *
 * @param payload - Receipt payload containing the claimed operation digest and binding flags.
 * @param components - Validated request components to compare against the receipt.
 * @returns Whether the digest matches plus both the expected and actual digest values.
 */
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
