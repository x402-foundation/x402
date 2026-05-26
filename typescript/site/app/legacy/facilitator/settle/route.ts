import { paymentDetailsSchema, PaymentDetails } from "x402-legacy/types";
import { settle } from "x402-legacy/facilitator";
import { evm } from "x402-legacy/shared";
import { Hex } from "viem";

/**
 * Request body for the legacy settle endpoint
 */
type SettleRequest = {
  payload: string;
  details: PaymentDetails;
};

/**
 * Settles a payment request using the legacy x402 protocol. This endpoint processes
 * the payment and returns the settlement result.
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
 * @returns A response containing the settlement result
 */
export async function POST(req: Request) {
  const body: SettleRequest = await req.json();
  const wallet = evm.wallet.createSignerSepolia(process.env.FACILITATOR_EVM_PRIVATE_KEY as Hex);

  const paymentDetails = paymentDetailsSchema.parse(body.details);

  const response = await settle(wallet, body.payload, paymentDetails);

  return Response.json(response);
}

/**
 * Returns documentation about the legacy settle endpoint, including request format
 * and expected response structure.
 *
 * @deprecated Legacy endpoint for x402@0.1.2. This endpoint is maintained for backward compatibility only.
 * @returns A response containing endpoint documentation
 */
export async function GET() {
  return Response.json({
    endpoint: "/settle",
    description: "POST to settle x402 payments (legacy v0.1.2)",
    body: {
      payload: "string",
      details: "PaymentDetails",
    },
  });
}
