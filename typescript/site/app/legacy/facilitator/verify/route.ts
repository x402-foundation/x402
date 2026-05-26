import { paymentDetailsSchema, PaymentDetails } from "x402-legacy/types";
import { verify } from "x402-legacy/facilitator";
import { evm } from "x402-legacy/shared";

/**
 * Request body for the legacy verify endpoint
 */
type VerifyRequest = {
  payload: string;
  details: PaymentDetails;
};

/**
 * Verifies a payment request using the legacy x402 protocol. This endpoint checks if a payment header
 * is valid for the given payment details.
 *
 * ## X-Payment Header Payload
 * The payload should be a base64 encoded JSON string containing:
 * - `x402Version`: Protocol version number
 * - `scheme`: Payment scheme identifier
 * - `network`: Network identifier
 * - `payload`: Scheme-specific payment data
 *
 * @deprecated Legacy endpoint for x402@0.1.2. This endpoint is maintained for backward compatibility only.
 * @param req - The incoming request containing the payment payload and details
 * @returns A response indicating whether the payment is valid
 */
export async function POST(req: Request) {
  const body: VerifyRequest = await req.json();
  const client = evm.wallet.createClientSepolia();

  const paymentDetails = paymentDetailsSchema.parse(body.details);

  const valid = await verify(client, body.payload, paymentDetails);

  return Response.json(valid);
}

/**
 * Returns documentation about the legacy verify endpoint, including request format
 * and expected response structure.
 *
 * @deprecated Legacy endpoint for x402@0.1.2. This endpoint is maintained for backward compatibility only.
 * @returns A response containing endpoint documentation
 */
export async function GET() {
  return Response.json({
    endpoint: "/verify",
    description: "POST to verify x402 payments (legacy v0.1.2)",
    body: {
      payload: "string",
      details: "PaymentDetails",
    },
  });
}
