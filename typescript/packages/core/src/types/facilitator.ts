import { PaymentPayload, PaymentRequirements } from "./payments";
import { Network } from "./";

export type VerifyRequest = {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

export type VerifyResponse = {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
  extensions?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

export type SettleRequest = {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

export type SettleResponse = {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: Network;
  /** Actual amount settled in atomic token units. Present for schemes like `upto` where settlement amount may differ from the authorized maximum. */
  amount?: string;
  extensions?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

export type SupportedKind = {
  x402Version: number;
  scheme: string;
  network: Network;
  extra?: Record<string, unknown>;
};

export type SupportedResponse = {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>; // CAIP family pattern → Signer addresses
};

/**
 * Error thrown when payment verification fails.
 */
export class VerifyError extends Error {
  readonly invalidReason?: string;
  readonly invalidMessage?: string;
  readonly payer?: string;
  readonly statusCode: number;

  /**
   * Creates a VerifyError from a failed verification response.
   *
   * @param statusCode - HTTP status code from the facilitator
   * @param response - The verify response containing failure details
   */
  constructor(statusCode: number, response: VerifyResponse) {
    const reason = response.invalidReason || "unknown reason";
    const message = response.invalidMessage;
    super(message ? `${reason}: ${message}` : reason);
    this.name = "VerifyError";
    this.statusCode = statusCode;
    this.invalidReason = response.invalidReason;
    this.invalidMessage = response.invalidMessage;
    this.payer = response.payer;
  }
}

/**
 * Error thrown when payment settlement fails.
 */
export class SettleError extends Error {
  readonly errorReason?: string;
  readonly errorMessage?: string;
  readonly payer?: string;
  readonly transaction: string;
  readonly network: Network;
  readonly statusCode: number;

  /**
   * Creates a SettleError from a failed settlement response.
   *
   * @param statusCode - HTTP status code from the facilitator
   * @param response - The settle response containing error details
   */
  constructor(statusCode: number, response: SettleResponse) {
    const reason = response.errorReason || "unknown reason";
    const message = response.errorMessage;
    super(message ? `${reason}: ${message}` : reason);
    this.name = "SettleError";
    this.statusCode = statusCode;
    this.errorReason = response.errorReason;
    this.errorMessage = response.errorMessage;
    this.payer = response.payer;
    this.transaction = response.transaction;
    this.network = response.network;
  }
}

/**
 * Error thrown when a facilitator returns malformed success payload data.
 */
export class FacilitatorResponseError extends Error {
  /**
   * Creates a FacilitatorResponseError for malformed facilitator responses.
   *
   * @param message - The boundary error message
   */
  constructor(message: string) {
    super(message);
    this.name = "FacilitatorResponseError";
  }
}

/**
 * Error thrown when a facilitator HTTP request exceeds the client's configured timeout.
 *
 * Extends FacilitatorResponseError so HTTP middlewares surface it as a facilitator
 * boundary failure (502) rather than an unhandled runtime error.
 *
 * Note: for settle(), a client-side timeout is an indeterminate outcome — the
 * facilitator may have received and completed the settlement after the client
 * stopped waiting. Callers must not treat this error as proof that settlement
 * did not occur.
 */
export class FacilitatorTimeoutError extends FacilitatorResponseError {
  /** The facilitator operation that timed out ("verify", "settle", or "supported") */
  readonly operation: string;
  /** The timeout that elapsed, in milliseconds */
  readonly timeoutMs: number;

  /**
   * Creates a FacilitatorTimeoutError.
   *
   * @param operation - The facilitator operation that timed out
   * @param timeoutMs - The configured timeout in milliseconds
   */
  constructor(operation: string, timeoutMs: number) {
    super(`Facilitator ${operation} request timed out after ${timeoutMs}ms`);
    this.name = "FacilitatorTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Walks an error cause chain to find the first facilitator response error.
 *
 * @param error - The thrown value to inspect
 * @returns The nested facilitator response error, if present
 */
export function getFacilitatorResponseError(error: unknown): FacilitatorResponseError | null {
  let current = error;

  while (current instanceof Error) {
    if (current instanceof FacilitatorResponseError) {
      return current;
    }
    current = current.cause;
  }

  return null;
}
