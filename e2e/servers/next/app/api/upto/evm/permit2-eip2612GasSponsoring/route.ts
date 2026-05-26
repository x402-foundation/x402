import { NextResponse } from "next/server";

/**
 * Upto Permit2 EIP-2612 endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    message: "Upto Permit2 EIP-2612 endpoint accessed successfully",
    timestamp: new Date().toISOString(),
    method: "upto-permit2-eip2612",
  });
}
