import { NextResponse } from "next/server";

/**
 * Upto Permit2 ERC-20 approval endpoint requiring payment (proxy middleware)
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    message: "Upto Permit2 ERC-20 approval endpoint accessed successfully",
    timestamp: new Date().toISOString(),
    method: "upto-permit2-erc20-approval",
  });
}
