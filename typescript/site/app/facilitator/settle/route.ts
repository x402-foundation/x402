import { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { parsePaymentPayload, parsePaymentRequirements } from "@x402/core/schemas";
import { getFacilitator } from "../index";

/**
 * Handles POST requests to settle x402 payments
 *
 * @param req - The incoming request containing payment settlement details
 * @returns A JSON response with the settlement result
 */
export async function POST(req: Request) {
  // Parse request body - only use "unknown:unknown" if parsing fails
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
        success: false,
        errorReason: "invalid_json",
        errorMessage: "Failed to parse request body",
        error: "Failed to parse request body",
        transaction: "",
        network: "unknown:unknown" as `${string}:${string}`,
      } as SettleResponse,
      { status: 400 },
    );
  }

  // Check for missing parameters
  if (!rawPaymentPayload || !rawPaymentRequirements) {
    return Response.json(
      {
        success: false,
        errorReason: "missing_parameters",
        errorMessage: "Missing paymentPayload or paymentRequirements",
        error: "Missing paymentPayload or paymentRequirements",
        transaction: "",
        network: "unknown:unknown" as `${string}:${string}`,
      } as SettleResponse,
      { status: 400 },
    );
  }

  // Validate against the real x402 (V1 or V2) schemas before ever touching
  // the payload's fields — see the identical guard in ../verify/route.ts for
  // the full rationale. Without this, a malformed or wrong-version body
  // reaches the scheme-specific settle handlers as an untyped `unknown`, and
  // a missing/mis-shaped field throws an uncaught TypeError surfaced as an
  // opaque HTTP 500 instead of a specific, actionable 400.
  const payloadResult = parsePaymentPayload(rawPaymentPayload);

  if (!payloadResult.success) {
    return Response.json(
      {
        success: false,
        errorReason: "invalid_payment_payload",
        errorMessage: `paymentPayload failed schema validation: ${payloadResult.error.message}`,
        error: payloadResult.error.message,
        transaction: "",
        network: "unknown:unknown" as `${string}:${string}`,
      } as SettleResponse,
      { status: 400 },
    );
  }

  const requirementsResult = parsePaymentRequirements(rawPaymentRequirements);

  if (!requirementsResult.success) {
    return Response.json(
      {
        success: false,
        errorReason: "invalid_payment_requirements",
        errorMessage: `paymentRequirements failed schema validation: ${requirementsResult.error.message}`,
        error: requirementsResult.error.message,
        transaction: "",
        network: "unknown:unknown" as `${string}:${string}`,
      } as SettleResponse,
      { status: 400 },
    );
  }

  const paymentPayload = payloadResult.data as PaymentPayload;
  const paymentRequirements = requirementsResult.data as PaymentRequirements;

  // At this point we know we have both paymentPayload and paymentRequirements
  const network = paymentRequirements.network;

  try {
    const facilitator = await getFacilitator();

    // Hooks will automatically:
    // - Validate payment was verified (onBeforeSettle - will abort if not)
    // - Check verification timeout (onBeforeSettle)
    // - Clean up tracking (onAfterSettle / onSettleFailure)
    const response: SettleResponse = await facilitator.settle(paymentPayload, paymentRequirements);

    return Response.json(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Settle error:", errorMessage);

    // Check if this was an abort from hook
    if (error instanceof Error && error.message.includes("Settlement aborted:")) {
      // Return a proper SettleResponse instead of 500 error
      return Response.json({
        success: false,
        errorReason: error.message.replace("Settlement aborted: ", ""),
        errorMessage: error.message.replace("Settlement aborted: ", ""),
        transaction: "",
        network: network,
      } as SettleResponse);
    }

    return Response.json(
      {
        success: false,
        errorReason: "unexpected_error",
        errorMessage: errorMessage,
        error: errorMessage,
        transaction: "",
        network: network,
      } as SettleResponse,
      { status: 500 },
    );
  }
}

/**
 * Provides API documentation for the settle endpoint
 *
 * @returns A JSON response describing the settle endpoint and its expected request body
 */
export async function GET() {
  return Response.json({
    endpoint: "/settle",
    description: "POST to settle x402 payments",
    body: {
      paymentPayload: "PaymentPayload",
      paymentRequirements: "PaymentRequirements",
    },
  });
}
