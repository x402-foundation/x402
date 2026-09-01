import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";

import type {
  MCPResultWithMeta,
  PaidResponseValidationView,
  ValidatePaidResponse,
  ValidatePaidResponseContext,
} from "../types";

const PAID_RESPONSE_DETACH_FAILURE =
  "Paid tool result cannot be detached for validation";

/**
 * Thrown when a caller-owned paid-response validator rejects a paid tool
 * result, or when a paid result cannot be detached for validation.
 *
 * Settlement evidence is preserved on {@link PaidResponseValidationError.result}
 * and {@link PaidResponseValidationError.paymentResponse} when present. The
 * client does not retry or create another payment after this error.
 */
export class PaidResponseValidationError extends Error {
  readonly paymentRequired?: PaymentRequired;
  readonly paymentPayload: PaymentPayload;
  readonly recovered: boolean;
  readonly paymentResponse?: SettleResponse;
  readonly result: MCPResultWithMeta;

  /**
   * Creates a paid-response validation error with preserved evidence.
   *
   * @param message - Human-readable failure message
   * @param result - Original paid tool result
   * @param paymentPayload - Payment payload used for the paid attempt
   * @param recovered - Whether this was the bounded recovery path
   * @param paymentRequired - Seller requirement when known
   * @param paymentResponse - Settlement metadata when present on the paid result
   * @param cause - Underlying validation or detach failure
   */
  constructor(
    message: string,
    result: MCPResultWithMeta,
    paymentPayload: PaymentPayload,
    recovered: boolean,
    paymentRequired?: PaymentRequired,
    paymentResponse?: SettleResponse,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "PaidResponseValidationError";
    this.result = result;
    this.paymentPayload = paymentPayload;
    this.recovered = recovered;
    this.paymentRequired = paymentRequired;
    this.paymentResponse = paymentResponse;
  }
}

/**
 * Deep-clones a value for detached validator input.
 *
 * @param value - Value to clone
 * @returns Detached clone
 */
function cloneValidationValue<T>(value: T): T {
  if (typeof structuredClone !== "function") {
    throw new Error(PAID_RESPONSE_DETACH_FAILURE);
  }

  try {
    return structuredClone(value);
  } catch (error) {
    throw new Error(PAID_RESPONSE_DETACH_FAILURE, { cause: error });
  }
}

/**
 * Builds a detached validation view from a paid tool result.
 *
 * @param result - Live paid tool result
 * @returns Detached view for the validator callback
 */
function createPaidResponseValidationView(
  result: MCPResultWithMeta,
): PaidResponseValidationView {
  const view: PaidResponseValidationView = {
    content: cloneValidationValue(result.content ?? []),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };

  if (result.structuredContent !== undefined) {
    view.structuredContent = cloneValidationValue(result.structuredContent);
  }

  return view;
}

/**
 * Preserves the live paid result attached to errors (validator receives clones only).
 *
 * @param result - Live paid tool result
 * @returns Evidence snapshot referencing the original fields
 */
function preserveResultEvidence(result: MCPResultWithMeta): MCPResultWithMeta {
  return {
    content: result.content ?? [],
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(result._meta !== undefined ? { _meta: result._meta } : {}),
  };
}

/**
 * Builds a detached validation context for the validator callback.
 *
 * @param context - Live validation context
 * @returns Detached context for the validator callback
 */
function buildValidationContext(
  context: ValidatePaidResponseContext,
): ValidatePaidResponseContext {
  const paymentResponse = context.paymentResponse;
  return {
    recovered: context.recovered,
    paymentPayload: cloneValidationValue(context.paymentPayload),
    ...(context.paymentRequired !== undefined
      ? { paymentRequired: cloneValidationValue(context.paymentRequired) }
      : {}),
    ...(paymentResponse !== undefined
      ? { paymentResponse: cloneValidationValue(paymentResponse) }
      : {}),
  };
}

/**
 * Runs the optional caller-owned paid-response validator on a paid tool result.
 *
 * @param validator - Caller-supplied validator, if any
 * @param result - Live paid tool result about to be returned
 * @param context - Validation context with optional seller and settlement fields
 */
export async function applyValidatePaidToolResult(
  validator: ValidatePaidResponse | undefined,
  result: MCPResultWithMeta,
  context: ValidatePaidResponseContext,
): Promise<void> {
  if (!validator) {
    return;
  }

  const paymentResponse = context.paymentResponse;
  let view: PaidResponseValidationView;
  let validationContext: ValidatePaidResponseContext;

  try {
    view = createPaidResponseValidationView(result);
    validationContext = buildValidationContext(context);
  } catch (error) {
    throw new PaidResponseValidationError(
      PAID_RESPONSE_DETACH_FAILURE,
      preserveResultEvidence(result),
      context.paymentPayload,
      context.recovered,
      context.paymentRequired,
      paymentResponse,
      error,
    );
  }

  try {
    await validator(view, validationContext);
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : "Paid response validation failed";
    throw new PaidResponseValidationError(
      message,
      preserveResultEvidence(result),
      context.paymentPayload,
      context.recovered,
      context.paymentRequired,
      paymentResponse,
      error,
    );
  }
}
