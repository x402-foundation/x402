import { NextResponse } from "next/server";

/**
 * Aptos endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    message: "Protected endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  });
}
