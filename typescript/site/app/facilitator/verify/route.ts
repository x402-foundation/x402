import { VerifyResponse, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { parsePaymentPayload, parsePaymentRequirements } from "@x402/core/schemas";
import { getFacilitator } from "../index";

/**
 * Handles POST requests to verify x402 payments
 *
 * @param req - The incoming request containing payment verification details
 * @returns A JSON response indicating whether the payment is valid
 */
export async function POST(req: Request) {
  // Parse request body - handle JSON parsing errors separately
  let rawPaymentPayload: unknown;
  let rawPaymentRequirements: unknown;

  try {
    const body = await req.json();
    rawPaymentPayload = body.paymentPayload;
    rawPaymentRequirements = body.paymentRequirements;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Failed to parse request body:", errorMessage);
    return Response.json(
      {
        isValid: false,
        invalidReason: "invalid_json",
        invalidMessage: "Failed to parse request body",
        error: "Failed to parse request body",
      } as VerifyResponse,
      { status: 400 },
    );
  }

  // Check for missing parameters
  if (!rawPaymentPayload || !rawPaymentRequirements) {
    return Response.json(
      {
        isValid: false,
        invalidReason: "missing_parameters",
        invalidMessage: "Missing paymentPayload or paymentRequirements",
        error: "Missing paymentPayload or paymentRequirements",
      } as VerifyResponse,
      { status: 400 },
    );
  }

  // Validate against the real x402 (V1 or V2) schemas before ever touching
  // the payload's fields. Without this, a malformed or wrong-version body
  // reaches facilitator.verify()/settle() (and the scheme-specific handlers
  // beneath it) as an untyped `unknown` cast to the expected type, and any
  // property access on a missing/mis-shaped field throws an uncaught
  // TypeError that surfaces as an opaque HTTP 500 "unexpected_error" instead
  // of a specific, actionable 400 — e.g. a v2 PaymentPayload missing the
  // required `accepted` field previously produced
  // "Cannot read properties of undefined (reading 'scheme')".
  const payloadResult = parsePaymentPayload(rawPaymentPayload);

  if (!payloadResult.success) {
    return Response.json(
      {
        isValid: false,
        invalidReason: "invalid_payment_payload",
        invalidMessage: `paymentPayload failed schema validation: ${payloadResult.error.message}`,
        error: payloadResult.error.message,
      } as VerifyResponse,
      { status: 400 },
    );
  }

  const requirementsResult = parsePaymentRequirements(rawPaymentRequirements);

  if (!requirementsResult.success) {
    return Response.json(
      {
        isValid: false,
        invalidReason: "invalid_payment_requirements",
        invalidMessage: `paymentRequirements failed schema validation: ${requirementsResult.error.message}`,
        error: requirementsResult.error.message,
      } as VerifyResponse,
      { status: 400 },
    );
  }

  const paymentPayload = payloadResult.data as PaymentPayload;
  const paymentRequirements = requirementsResult.data as PaymentRequirements;

  try {
    const facilitator = await getFacilitator();

    // Hooks will automatically:
    // - Track verified payment (onAfterVerify)
    // - Extract and catalog discovery info (onAfterVerify)
    const response: VerifyResponse = await facilitator.verify(paymentPayload, paymentRequirements);

    return Response.json(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Verify error:", errorMessage);
    return Response.json(
      {
        isValid: false,
        invalidReason: "unexpected_error",
        invalidMessage: errorMessage,
        error: errorMessage,
      } as VerifyResponse,
      { status: 500 },
    );
  }
}

/**
 * Provides API documentation for the verify endpoint
 *
 * @returns A JSON response describing the verify endpoint and its expected request body
 */
export async function GET() {
  return Response.json({
    endpoint: "/verify",
    description: "POST to verify x402 payments",
    body: {
      paymentPayload: "PaymentPayload",
      paymentRequirements: "PaymentRequirements",
    },
  });
}
