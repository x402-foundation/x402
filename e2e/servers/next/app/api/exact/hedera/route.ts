import { NextResponse } from "next/server";

/**
 * Hedera endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    message: "Protected Hedera endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  });
}
