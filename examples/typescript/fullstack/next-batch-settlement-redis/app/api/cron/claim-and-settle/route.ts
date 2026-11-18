import { NextRequest, NextResponse } from "next/server";

import { authorizeCronRequest } from "../../../../lib/cronAuth";
import { runClaimAndSettleCron } from "../../../../lib/cron";

/**
 * Runs the scheduled batch-settlement claim-and-settle job.
 *
 * @param request - Incoming cron request.
 * @returns JSON claim-and-settle summary.
 */
export async function GET(request: NextRequest) {
  const unauthorized = authorizeCronRequest(request);
  if (unauthorized) {
    return unauthorized;
  }

  const summary = await runClaimAndSettleCron({ maxClaimsPerBatch: 100 });
  return NextResponse.json(summary);
}
