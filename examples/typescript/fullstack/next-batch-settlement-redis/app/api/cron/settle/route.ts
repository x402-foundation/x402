import { NextRequest, NextResponse } from "next/server";

import { authorizeCronRequest } from "../../../../lib/cronAuth";
import { runSettleCron } from "../../../../lib/cron";

/**
 * Runs the scheduled batch-settlement settle job.
 *
 * @param request - Incoming cron request.
 * @returns JSON settle summary.
 */
export async function GET(request: NextRequest) {
  const unauthorized = authorizeCronRequest(request);
  if (unauthorized) {
    return unauthorized;
  }

  const summary = await runSettleCron();
  return NextResponse.json(summary);
}
