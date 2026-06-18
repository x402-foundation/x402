import { NextResponse } from "next/server";

/**
 * NEAR endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    message: "Protected NEAR endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  });
}
