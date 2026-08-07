import { NextResponse } from "next/server";

/**
 * TVM endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

/**
 * Handles the protected TVM endpoint.
 *
 * @returns JSON response for a successful TVM payment.
 */
export async function GET() {
  return NextResponse.json({
    message: "Protected TVM endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  });
}
