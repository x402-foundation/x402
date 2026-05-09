import { NextResponse } from "next/server";
import { SETTLEMENT_OVERRIDES_HEADER } from "@x402/core/server";

/**
 * Upto Permit2 direct endpoint requiring payment (proxy middleware)
 * Client must have Permit2 pre-approved. Settles partial amount (1000 of 2000 authorized).
 */
export const runtime = "nodejs";

export async function GET() {
  const response = NextResponse.json({
    message: "Upto Permit2 endpoint accessed successfully",
    timestamp: new Date().toISOString(),
    method: "upto-permit2",
  });
  response.headers.set(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify({ amount: "1000" }));
  return response;
}
