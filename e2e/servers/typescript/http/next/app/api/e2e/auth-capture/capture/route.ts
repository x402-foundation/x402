import { NextRequest, NextResponse } from "next/server";

import { runAuthCaptureE2eCapture } from "../../../../../../../auth-capture-e2e";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { path?: string };
  const result = await runAuthCaptureE2eCapture(body.path);
  return NextResponse.json(result.body, { status: result.status });
}
