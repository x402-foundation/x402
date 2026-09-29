import { NextResponse } from "next/server";
import { buildCloseResponse } from "../../../../../routes";

export const runtime = "nodejs";

export async function POST() {
  console.log("Received shutdown request");
  setTimeout(() => {
    console.log("Shutting down Next.js server");
    process.exit(0);
  }, 1000);
  return NextResponse.json(buildCloseResponse());
}
