import { NextResponse } from "next/server";

/**
 * Graceful shutdown endpoint
 */
export const runtime = "nodejs";

/**
 * Graceful shutdown endpoint
 */
export async function POST() {
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
