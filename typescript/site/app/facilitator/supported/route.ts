import { getFacilitator } from "../index";

/**
 * Returns the supported payment kinds for the x402 protocol
 *
 * @returns A JSON response containing the list of supported payment kinds
 */
export async function GET() {
  try {
    const facilitator = await getFacilitator();
    const response = facilitator.getSupported();
    return Response.json(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Supported error:", errorMessage);
    return Response.json(
      {
        error: errorMessage,
      },
      { status: 500 },
    );
  }
}
