import { NextResponse } from "next/server";

/**
 * Casper endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

/**
 * Handles requests for the protected Casper endpoint.
 *
 * @returns JSON response after payment middleware validation.
 */
export async function GET() {
  return NextResponse.json({
    message: "Protected Casper endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  });
}
