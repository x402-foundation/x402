import { NextResponse } from "next/server";
import { loadServerEnv } from "../../../../../config";
import { buildHealthResponse } from "../../../../../routes";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(buildHealthResponse(loadServerEnv()));
}
