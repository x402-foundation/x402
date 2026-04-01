import { NextResponse } from "next/server";

/**
 * Stellar endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    message: "Protected endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  });
}
