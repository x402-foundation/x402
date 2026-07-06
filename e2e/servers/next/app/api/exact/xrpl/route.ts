import { NextResponse } from "next/server";

/**
 * XRPL endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    message: "Protected XRPL endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  });
}
