import { NextResponse } from "next/server";

/**
 * Batch-settlement EVM endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    message: "Batch-settlement endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  });
}
