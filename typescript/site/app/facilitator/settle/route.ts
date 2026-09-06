import { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { getFacilitator } from "../index";

/**
 * Handles POST requests to settle x402 payments
 *
 * @param req - The incoming request containing payment settlement details
 * @returns A JSON response with the settlement result
 */
export async function POST(req: Request) {
  // Parse request body - only use "unknown:unknown" if parsing fails
  let paymentPayload: PaymentPayload | undefined;
  let paymentRequirements: PaymentRequirements | undefined;

  try {
    const body = await req.json();
    paymentPayload = body.paymentPayload as PaymentPayload;
    paymentRequirements = body.paymentRequirements as PaymentRequirements;
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
  if (!paymentPayload || !paymentRequirements) {
    return Response.json(
      {
        success: false,
        errorReason: "missing_parameters",
        errorMessage: "Missing paymentPayload or paymentRequirements",
        error: "Missing paymentPayload or paymentRequirements",
        transaction: "",
        // Use network from paymentRequirements if available, otherwise unknown
        network: (paymentRequirements?.network || "unknown:unknown") as `${string}:${string}`,
      } as SettleResponse,
      { status: 400 },
    );
  }

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
