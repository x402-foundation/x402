import { NextRequest, NextResponse } from "next/server";

import { authorizeCronRequest } from "../../../../lib/cronAuth";
import { runClaimCron } from "../../../../lib/cron";

/**
 * Runs the scheduled batch-settlement claim job.
 *
 * @param request - Incoming cron request.
 * @returns JSON claim summary.
 */
export async function GET(request: NextRequest) {
  const unauthorized = authorizeCronRequest(request);
  if (unauthorized) {
    return unauthorized;
  }

  const summary = await runClaimCron({ maxClaimsPerBatch: 100 });
  return NextResponse.json(summary);
}
