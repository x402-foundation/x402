import { NextResponse } from "next/server";

/**
 * Batch-settlement Permit2 direct endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    message: "Batch-settlement Permit2 endpoint accessed successfully",
    timestamp: new Date().toISOString(),
    method: "batch-settlement-permit2",
  });
}
