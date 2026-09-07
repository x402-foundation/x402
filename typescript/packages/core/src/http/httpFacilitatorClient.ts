import { PaymentPayload, PaymentRequirements } from "../types/payments";
import {
  VerifyResponse,
  SettleResponse,
  SupportedResponse,
  VerifyError,
  SettleError,
  FacilitatorResponseError,
  FacilitatorTimeoutError,
} from "../types/facilitator";
import { z } from "../schemas";
import { safeBase64Decode } from "../utils";

const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";
/** Default per-request timeout for facilitator HTTP calls, in milliseconds */
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Upper bound for timeoutMs (2^31 - 1). AbortSignal.timeout() requires an
 * integer, and larger values overflow Node's 32-bit timers, which would
 * silently fire after ~1ms while reporting the configured duration.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface FacilitatorConfig {
  url?: string;
  /**
   * Timeout in milliseconds applied to each facilitator HTTP request —
   * `verify()`, `settle()`, and every `getSupported()` attempt — covering both
   * response headers and body consumption. Must be a positive integer no
   * greater than 2_147_483_647 (2^31 - 1, about 24.8 days).
   * Defaults to 30_000 (30 seconds), matching the Go and Python facilitator clients.
   *
   * On expiry the operation rejects with {@link FacilitatorTimeoutError}. For
   * `settle()` a timeout is an indeterminate outcome: the facilitator may still
   * have completed the settlement.
   */
  timeoutMs?: number;
  /**
   * Returns authentication headers for the facilitator, keyed by request path.
   *
   * The returned object must be keyed by path (`verify`, `settle`, `supported`,
   * and optionally `bazaar`), each mapping to a headers object — NOT a flat
   * headers object. Paths may be omitted (no auth is sent for them), but
   * returning a flat object such as `{ Authorization: "Bearer ..." }` will
   * throw, since it would otherwise silently drop auth on every request.
   *
   * @example
   * ```ts
   * createAuthHeaders: async () => {
   *   const headers = { Authorization: `Bearer ${token}` };
   *   return { verify: headers, settle: headers, supported: headers };
   * }
   * ```
   */
  createAuthHeaders?: () => Promise<{
    verify?: Record<string, string>;
    settle?: Record<string, string>;
    supported?: Record<string, string>;
    bazaar?: Record<string, string>;
  }>;
}

/**
 * Interface for facilitator clients
 * Can be implemented for HTTP-based or local facilitators
 */
export interface FacilitatorClient {
  /**
   * Verify a payment with the facilitator
   *
   * @param paymentPayload - The payment to verify
   * @param paymentRequirements - The requirements to verify against
   * @returns Verification response
   */
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse>;

  /**
   * Settle a payment with the facilitator
   *
   * @param paymentPayload - The payment to settle
   * @param paymentRequirements - The requirements for settlement
   * @returns Settlement response
   */
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse>;

  /**
   * Get supported payment kinds and extensions from the facilitator
   *
   * @returns Supported payment kinds and extensions
   */
  getSupported(): Promise<SupportedResponse>;
}

/** Number of retries for getSupported() on 429 rate limit errors */
const GET_SUPPORTED_RETRIES = 3;
/** Base delay in ms for exponential backoff on retries */
const GET_SUPPORTED_RETRY_DELAY_MS = 1000;
/** Upper bound on retry delay to prevent pathological waits from a misbehaving server */
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Resolves the delay before the next 429 retry. Parses Retry-After per RFC 7231 §7.1.3
 * (delta-seconds or HTTP-date) and falls back to exponential backoff when the header
 * is absent, unparseable, or non-positive. The result is clamped to MAX_RETRY_DELAY_MS.
 *
 * @param retryAfter - Raw `Retry-After` header value, or null if not present
 * @param attempt - Zero-based retry attempt index used for exponential backoff
 * @returns Delay in milliseconds to wait before the next attempt
 */
export function computeRetryDelay(retryAfter: string | null, attempt: number): number {
  let delay: number | null = null;

  if (retryAfter !== null) {
    const trimmedRetryAfter = retryAfter.trim();
    if (/^\d+$/.test(trimmedRetryAfter)) {
      // delta-seconds form
      delay = Number(trimmedRetryAfter) * 1000;
    } else {
      // HTTP-date form
      const retryDate = Date.parse(retryAfter);
      if (!isNaN(retryDate)) {
        delay = retryDate - Date.now();
      }
    }
  }

  // Fall back to exponential backoff for missing, invalid, or non-positive values
  if (delay === null || delay <= 0) {
    delay = GET_SUPPORTED_RETRY_DELAY_MS * Math.pow(2, attempt);
  }

  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/**
 * Bounds the payment-required and facilitator responses buffered by this package.
 * Control-plane JSON is small, so a tight limit is enough.
 */
export const MAX_CONTROL_PLANE_RESPONSE_BYTES = 1 << 20;

/**
 * Error thrown when an HTTP response body exceeds the buffering limit applied by
 * x402 clients.
 */
export class ResponseBodyTooLargeError extends Error {
  readonly limitBytes: number;

  /**
   * Creates a ResponseBodyTooLargeError for an oversized HTTP response body.
   *
   * @param limitBytes - The buffering limit that the response exceeded, in bytes
   */
  constructor(limitBytes: number) {
    super(`http response body too large: limit ${limitBytes} bytes`);
    this.name = "ResponseBodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/**
 * Reads at most `maxBytes` from a fetch response. A larger body throws
 * {@link ResponseBodyTooLargeError} without buffering the rest.
 *
 * @param response - The HTTP response whose body should be buffered
 * @param maxBytes - Maximum number of bytes to buffer
 * @returns The decoded response body
 */
export async function readLimitedBody(
  response: Response,
  maxBytes: number = MAX_CONTROL_PLANE_RESPONSE_BYTES,
): Promise<string> {
  const stream = response.body;
  if (!stream) {
    return "";
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      if (total + value.byteLength > maxBytes) {
        throw new ResponseBodyTooLargeError(maxBytes);
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }

  if (total === 0) {
    return "";
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const verifyResponseSchema: z.ZodType<VerifyResponse, z.ZodTypeDef, unknown> = z.object({
  isValid: z.boolean(),
  invalidReason: z
    .string()
    .nullish()
    .transform(v => v ?? undefined),
  invalidMessage: z
    .string()
    .nullish()
    .transform(v => v ?? undefined),
  payer: z
    .string()
    .nullish()
    .transform(v => v ?? undefined),
  extensions: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform(v => v ?? undefined),
  extra: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform(v => v ?? undefined),
});

const settleResponseSchema: z.ZodType<SettleResponse, z.ZodTypeDef, unknown> = z.object({
  success: z.boolean(),
  errorReason: z
    .string()
    .nullish()
    .transform(v => v ?? undefined),
  errorMessage: z
    .string()
    .nullish()
    .transform(v => v ?? undefined),
  payer: z
    .string()
    .nullish()
    .transform(v => v ?? undefined),
  transaction: z.string(),
  network: z.custom<SettleResponse["network"]>(value => typeof value === "string"),
  amount: z
    .string()
    .nullish()
    .transform(v => v ?? undefined),
  extensions: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform(v => v ?? undefined),
  extra: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform(v => v ?? undefined),
});

const supportedKindSchema: z.ZodType<SupportedResponse["kinds"][number], z.ZodTypeDef, unknown> =
  z.object({
    x402Version: z.number(),
    scheme: z.string(),
    network: z.custom<SupportedResponse["kinds"][number]["network"]>(
      value => typeof value === "string",
    ),
    extra: z
      .record(z.string(), z.unknown())
      .nullish()
      .transform(v => v ?? undefined),
  });

const supportedResponseSchema: z.ZodType<SupportedResponse, z.ZodTypeDef, unknown> = z.object({
  kinds: z.array(supportedKindSchema),
  extensions: z.array(z.string()).default([]),
  signers: z.record(z.string(), z.array(z.string())).default({}),
});

/**
 * Produces a compact excerpt of a facilitator response body for error messages.
 *
 * @param text - The raw response body text
 * @param limit - The maximum number of characters to include
 * @returns A normalized excerpt suitable for logs and thrown errors
 */
function responseExcerpt(text: string, limit: number = 200): string {
  const compact = text.trim().replace(/\s+/g, " ");
  if (!compact) {
    return "<empty response>";
  }

  if (compact.length <= limit) {
    return compact;
  }

  return `${compact.slice(0, limit - 3)}...`;
}

/**
 * Returns true when an error (or anything in its cause chain) is an abort or
 * timeout failure raised by an AbortSignal, across runtime error shapes.
 *
 * @param error - The thrown value to inspect
 * @returns Whether the failure was caused by an aborted request
 */
function isAbortOrTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current !== null && typeof current === "object"; depth++) {
    const name = (current as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const EXTENSION_RESPONSE_LOG_FIELD_ALLOWLIST = ["status", "rejectedReason", "reason", "code"];

/**
 * Decodes the facilitator `EXTENSION-RESPONSES` header into a plain object.
 * Returns undefined when the header is missing or malformed.
 *
 * @param response - The HTTP response from the facilitator
 * @returns Decoded extension responses, or undefined if missing/malformed
 */
function extractExtensionResponsesHeader(response: Response): Record<string, unknown> | undefined {
  const header = response.headers.get("EXTENSION-RESPONSES");
  if (!header) return undefined;
  try {
    const decoded = JSON.parse(safeBase64Decode(header));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return undefined;
    }
    return decoded as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Reads the `EXTENSION-RESPONSES` header from a facilitator HTTP response and logs
 * allowlisted fields. Silently ignores malformed headers.
 *
 * @param response - The HTTP response from the facilitator
 * @param decoded - Optional pre-decoded header object (avoids double-parse)
 */
function logExtensionResponsesHeader(response: Response, decoded?: Record<string, unknown>): void {
  const payload = decoded ?? extractExtensionResponsesHeader(response);
  if (!payload) return;
  try {
    const sanitized: Record<string, Record<string, unknown>> = {};
    for (const [extensionKey, value] of Object.entries(payload)) {
      const source =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const filtered: Record<string, unknown> = {};
      for (const key of EXTENSION_RESPONSE_LOG_FIELD_ALLOWLIST) {
        if (source[key] !== undefined) {
          filtered[key] = source[key];
        }
      }
      sanitized[extensionKey] = filtered;
    }
    console.log(`[x402] extension responses: ${JSON.stringify(sanitized)}`);
  } catch {
    // Ignore malformed payload shapes
  }
}

/**
 * Attach decoded EXTENSION-RESPONSES onto `extensionResponses` (server-internal
 * sidechannel). Never merges into `extensions`, which remains body-only and may
 * be forwarded to buyers via PAYMENT-RESPONSE.
 *
 * @param result - Facilitator response object to annotate
 * @param response - The HTTP response from the facilitator
 * @returns The same result, possibly with extensionResponses set
 */
function attachExtensionResponsesFromHeader<
  T extends { extensionResponses?: Record<string, unknown> },
>(result: T, response: Response): T {
  const headerExtensions = extractExtensionResponsesHeader(response);
  logExtensionResponsesHeader(response, headerExtensions);
  if (headerExtensions) {
    result.extensionResponses = headerExtensions;
  }
  return result;
}

/**
 * Parses and validates a successful facilitator response body.
 *
 * @param response - The HTTP response returned by the facilitator
 * @param schema - The schema used to validate the response payload
 * @param operation - The facilitator operation name for error reporting
 * @returns The validated facilitator payload
 */
async function parseSuccessResponse<T>(
  response: Response,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  operation: string,
): Promise<T> {
  const text = await readLimitedBody(response);

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FacilitatorResponseError(
      `Facilitator ${operation} returned invalid JSON: ${responseExcerpt(text)}`,
    );
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new FacilitatorResponseError(
      `Facilitator ${operation} returned invalid data: ${responseExcerpt(text)}`,
    );
  }

  return parsed.data;
}

/**
 * HTTP-based client for interacting with x402 facilitator services
 * Handles HTTP communication with facilitator endpoints
 */
export class HTTPFacilitatorClient implements FacilitatorClient {
  readonly url: string;
  /** Per-request timeout for facilitator HTTP calls, in milliseconds. */
  readonly timeoutMs: number;
  private readonly _createAuthHeaders?: FacilitatorConfig["createAuthHeaders"];

  /**
   * Creates a new HTTPFacilitatorClient instance.
   *
   * @param config - Configuration options for the facilitator client
   */
  constructor(config?: FacilitatorConfig) {
    // Normalize URL: strip trailing slashes to prevent redirect loops (e.g. 308)
    // when constructing endpoint paths like `${url}/supported`
    this.url = (config?.url || DEFAULT_FACILITATOR_URL).replace(/\/+$/, "");
    const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError(
        `timeoutMs must be a positive integer number of milliseconds no greater than ${MAX_TIMEOUT_MS}, got ${timeoutMs}`,
      );
    }
    this.timeoutMs = timeoutMs;
    this._createAuthHeaders = config?.createAuthHeaders;
  }

  /**
   * Verify a payment with the facilitator
   *
   * @param paymentPayload - The payment to verify
   * @param paymentRequirements - The requirements to verify against
   * @returns Verification response
   */
  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this._createAuthHeaders) {
      const authHeaders = await this.createAuthHeaders("verify");
      headers = { ...headers, ...authHeaders.headers };
    }

    return this.withRequestTimeout("verify", async signal => {
      const response = await fetch(`${this.url}/verify`, {
        method: "POST",
        headers,
        redirect: "follow",
        body: JSON.stringify({
          x402Version: paymentPayload.x402Version,
          paymentPayload: this.toJsonSafe(paymentPayload),
          paymentRequirements: this.toJsonSafe(paymentRequirements),
        }),
        signal,
      });

      if (!response.ok) {
        const text = await readLimitedBody(response);
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(
            `Facilitator verify failed (${response.status}): ${responseExcerpt(text)}`,
          );
        }

        if (typeof data === "object" && data !== null && "isValid" in data) {
          throw new VerifyError(response.status, data as VerifyResponse);
        }

        throw new Error(
          `Facilitator verify failed (${response.status}): ${responseExcerpt(JSON.stringify(data))}`,
        );
      }

      const verifyResult = await parseSuccessResponse(response, verifyResponseSchema, "verify");
      return attachExtensionResponsesFromHeader(verifyResult, response);
    });
  }

  /**
   * Settle a payment with the facilitator
   *
   * @param paymentPayload - The payment to settle
   * @param paymentRequirements - The requirements for settlement
   * @returns Settlement response
   */
  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this._createAuthHeaders) {
      const authHeaders = await this.createAuthHeaders("settle");
      headers = { ...headers, ...authHeaders.headers };
    }

    return this.withRequestTimeout("settle", async signal => {
      const response = await fetch(`${this.url}/settle`, {
        method: "POST",
        headers,
        redirect: "follow",
        body: JSON.stringify({
          x402Version: paymentPayload.x402Version,
          paymentPayload: this.toJsonSafe(paymentPayload),
          paymentRequirements: this.toJsonSafe(paymentRequirements),
        }),
        signal,
      });

      if (!response.ok) {
        const text = await readLimitedBody(response);
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(
            `Facilitator settle failed (${response.status}): ${responseExcerpt(text)}`,
          );
        }

        if (typeof data === "object" && data !== null && "success" in data) {
          throw new SettleError(response.status, data as SettleResponse);
        }

        throw new Error(
          `Facilitator settle failed (${response.status}): ${responseExcerpt(JSON.stringify(data))}`,
        );
      }

      const settleResult = await parseSuccessResponse(response, settleResponseSchema, "settle");
      return attachExtensionResponsesFromHeader(settleResult, response);
    });
  }

  /**
   * Get supported payment kinds and extensions from the facilitator.
   * Retries with exponential backoff on 429 rate limit errors.
   *
   * @returns Supported payment kinds and extensions
   */
  async getSupported(): Promise<SupportedResponse> {
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this._createAuthHeaders) {
      const authHeaders = await this.createAuthHeaders("supported");
      headers = { ...headers, ...authHeaders.headers };
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < GET_SUPPORTED_RETRIES; attempt++) {
      const outcome = await this.withRequestTimeout("supported", async signal => {
        const response = await fetch(`${this.url}/supported`, {
          method: "GET",
          headers,
          redirect: "follow",
          signal,
        });

        if (response.ok) {
          return {
            kind: "success" as const,
            value: await parseSuccessResponse(response, supportedResponseSchema, "supported"),
          };
        }

        const errorText = await readLimitedBody(response).catch((cause: unknown) => {
          // A deadline abort during the error-body read must surface as a
          // timeout, not be masked as a generic HTTP failure (which would be
          // retried for 429). statusText covers other body-read failures.
          if (isAbortOrTimeoutError(cause) || cause instanceof ResponseBodyTooLargeError) {
            throw cause;
          }
          return response.statusText;
        });
        return {
          kind: "http-error" as const,
          status: response.status,
          retryAfter: response.headers.get("Retry-After"),
          error: new Error(
            `Facilitator getSupported failed (${response.status}): ${responseExcerpt(errorText)}`,
          ),
        };
      });

      if (outcome.kind === "success") {
        return outcome.value;
      }

      lastError = outcome.error;

      // Retry on 429, honoring the server's Retry-After when available.
      if (outcome.status === 429 && attempt < GET_SUPPORTED_RETRIES - 1) {
        const delay = computeRetryDelay(outcome.retryAfter, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw lastError;
    }

    throw lastError ?? new Error("Facilitator getSupported failed after retries");
  }

  /**
   * Creates authentication headers for a specific path.
   *
   * @param path - The path to create authentication headers for (e.g., "verify", "settle", "supported")
   * @returns An object containing the authentication headers for the specified path
   */
  async createAuthHeaders(path: string): Promise<{
    headers: Record<string, string>;
  }> {
    if (!this._createAuthHeaders) {
      return { headers: {} };
    }

    const authHeaders = (await this._createAuthHeaders()) as Record<string, unknown>;

    // `createAuthHeaders` must return an object keyed by facilitator path
    // (`verify` | `settle` | `supported` | `bazaar`), whose values are header
    // objects.
    // A common mistake is returning a flat headers object (e.g.
    // `{ Authorization: "Bearer ..." }`), which would otherwise index to
    // `undefined` here and silently drop auth on every request. Detect that
    // shape and fail loudly instead. See
    // https://github.com/x402-foundation/x402/issues/2762
    const isHeaderObject = (value: unknown): value is Record<string, string> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const hasPathKey = ["verify", "settle", "supported", "bazaar"].some(key =>
      isHeaderObject(authHeaders[key]),
    );
    const looksFlat =
      !hasPathKey && Object.values(authHeaders).some(value => !isHeaderObject(value));
    if (looksFlat) {
      throw new Error(
        "createAuthHeaders must return an object keyed by facilitator path, e.g. " +
          '{ verify: { Authorization: "..." }, settle: { ... }, supported: { ... } }, ' +
          "but received a flat headers object. See " +
          "https://github.com/x402-foundation/x402/issues/2762",
      );
    }

    const headersForPath = authHeaders[path];
    return {
      headers: isHeaderObject(headersForPath) ? headersForPath : {},
    };
  }

  /**
   * Runs a single facilitator HTTP attempt under this client's request deadline.
   * The provided signal must be passed to `fetch` so the deadline also covers
   * response-body consumption.
   *
   * @param operation - The facilitator operation name ("verify", "settle", "supported")
   * @param run - The attempt to execute with the deadline's AbortSignal
   * @returns The attempt's result
   * @throws FacilitatorTimeoutError when the deadline elapses before completion
   */
  private async withRequestTimeout<T>(
    operation: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      return await run(signal);
    } catch (error) {
      if (signal.aborted && isAbortOrTimeoutError(error)) {
        throw new FacilitatorTimeoutError(operation, this.timeoutMs);
      }
      throw error;
    }
  }

  /**
   * Helper to convert objects to JSON-safe format.
   * Handles BigInt and other non-JSON types.
   *
   * @param obj - The object to convert
   * @returns The JSON-safe representation of the object
   */
  private toJsonSafe(obj: unknown): unknown {
    return JSON.parse(
      JSON.stringify(obj, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
    );
  }
}
