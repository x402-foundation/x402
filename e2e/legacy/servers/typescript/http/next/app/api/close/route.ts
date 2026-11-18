import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Graceful shutdown endpoint.
 *
 * @returns JSON body confirming shutdown was requested
 */
export async function POST(): Promise<NextResponse> {
  console.log("Received shutdown request");

  // Simple approach: exit after a short delay to allow response to be sent
  setTimeout(() => {
    console.log("Shutting down Next.js server");
    process.exit(0);
  }, 1000);

  return NextResponse.json({
    message: "Shutting down gracefully",
  });
}
