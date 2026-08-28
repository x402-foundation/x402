import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Health check endpoint.
 *
 * @returns JSON body with service status
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    status: "healthy",
  });
}
