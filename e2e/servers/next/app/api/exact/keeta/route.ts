import { NextResponse } from "next/server";

/**
 * Keeta endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    message: "Protected Keeta endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  });
}
