import { NextRequest, NextResponse } from "next/server";

/**
 * Checks the optional bearer secret used by cron endpoints.
 *
 * @param request - Incoming cron request.
 * @returns Unauthorized response when the configured secret is missing or invalid.
 */
export function authorizeCronRequest(request: NextRequest): NextResponse | undefined {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return undefined;
  }

  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return undefined;
}
