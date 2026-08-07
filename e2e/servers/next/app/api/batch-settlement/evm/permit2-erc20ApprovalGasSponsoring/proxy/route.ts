import { NextResponse } from "next/server";

/**
 * Batch-settlement Permit2 ERC-20 approval endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    message: "Batch-settlement Permit2 ERC-20 approval endpoint accessed successfully",
    timestamp: new Date().toISOString(),
    method: "batch-settlement-permit2-erc20-approval",
  });
}
