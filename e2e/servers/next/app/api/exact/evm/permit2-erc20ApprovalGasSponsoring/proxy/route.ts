import { NextResponse } from "next/server";

/**
 * EVM Permit2 ERC-20 approval gas sponsoring endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    message: "Protected endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  });
}
