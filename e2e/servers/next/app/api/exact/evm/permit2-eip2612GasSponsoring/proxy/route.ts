import { NextResponse } from "next/server";

/**
 * EVM Permit2 EIP-2612 gas sponsoring endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    message: "Protected endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  });
}
