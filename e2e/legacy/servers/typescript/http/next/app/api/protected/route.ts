import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Protected endpoint requiring payment.
 *
 * @returns JSON body with access confirmation and timestamp
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    message: "Protected endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  });
}
