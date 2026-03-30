import { PaymentPayload, PaymentRequirements } from "../types/payments";
import {
  VerifyResponse,
  SettleResponse,
  SupportedResponse,
  VerifyError,
  SettleError,
  FacilitatorResponseError,
} from "../types/facilitator";
import { z } from "../schemas";

const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

export interface FacilitatorConfig {
  url?: string;
  createAuthHeaders?: () => Promise<{
    verify: Record<string, string>;
    settle: Record<string, string>;
    supported: Record<string, string>;
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
  extensions: z
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
  const text = await response.text();

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

    const response = await fetch(`${this.url}/verify`, {
      method: "POST",
      headers,
      redirect: "follow",
      body: JSON.stringify({
        x402Version: paymentPayload.x402Version,
        paymentPayload: this.toJsonSafe(paymentPayload),
        paymentRequirements: this.toJsonSafe(paymentRequirements),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Facilitator verify failed (${response.status}): ${responseExcerpt(text)}`);
      }

      if (typeof data === "object" && data !== null && "isValid" in data) {
        throw new VerifyError(response.status, data as VerifyResponse);
      }

      throw new Error(
        `Facilitator verify failed (${response.status}): ${responseExcerpt(JSON.stringify(data))}`,
      );
    }

    return parseSuccessResponse(response, verifyResponseSchema, "verify");
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

    const response = await fetch(`${this.url}/settle`, {
      method: "POST",
      headers,
      redirect: "follow",
      body: JSON.stringify({
        x402Version: paymentPayload.x402Version,
        paymentPayload: this.toJsonSafe(paymentPayload),
        paymentRequirements: this.toJsonSafe(paymentRequirements),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Facilitator settle failed (${response.status}): ${responseExcerpt(text)}`);
      }

      if (typeof data === "object" && data !== null && "success" in data) {
        throw new SettleError(response.status, data as SettleResponse);
      }

      throw new Error(
        `Facilitator settle failed (${response.status}): ${responseExcerpt(JSON.stringify(data))}`,
      );
    }

    return parseSuccessResponse(response, settleResponseSchema, "settle");
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
      const response = await fetch(`${this.url}/supported`, {
        method: "GET",
        headers,
        redirect: "follow",
      });

      if (response.ok) {
        return parseSuccessResponse(response, supportedResponseSchema, "supported");
      }

      const errorText = await response.text().catch(() => response.statusText);
      lastError = new Error(
        `Facilitator getSupported failed (${response.status}): ${responseExcerpt(errorText)}`,
      );

      // Retry on 429 rate limit errors with exponential backoff
      if (response.status === 429 && attempt < GET_SUPPORTED_RETRIES - 1) {
        const delay = GET_SUPPORTED_RETRY_DELAY_MS * Math.pow(2, attempt);
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
    if (this._createAuthHeaders) {
      const authHeaders = (await this._createAuthHeaders()) as Record<
        string,
        Record<string, string>
      >;
      return {
        headers: authHeaders[path] ?? {},
      };
    }
    return {
      headers: {},
    };
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
