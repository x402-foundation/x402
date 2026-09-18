import { setSettlementOverrides, withX402 } from "@x402/next";
import { NextRequest, NextResponse } from "next/server";
import {
  buildSvmUptoAccept,
  ensureSvmUptoRegistered,
  svmResourceServer,
  UPTO_SETTLEMENT_OVERRIDE,
  withJsonPaymentRequired,
} from "@/lib/testnetProtectedResources";

/**
 * Testnet demo handler for the SVM `upto` endpoint. Authorizes 2x the exact price but
 * settles only {@link UPTO_SETTLEMENT_OVERRIDE} of it.
 *
 * @param _ - Incoming Next.js request (unused; content is static)
 * @returns JSON confirmation of successful payment, with the settlement override applied
 */
const handler = async (_: NextRequest): Promise<NextResponse> => {
  const response = NextResponse.json({
    ok: true,
    caip2Family: "svm",
    scheme: "upto",
    settledPercentOfAuthorized: UPTO_SETTLEMENT_OVERRIDE,
  });
  setSettlementOverrides(response, { amount: UPTO_SETTLEMENT_OVERRIDE });
  return response;
};

const routes = {
  "GET /protected/svm/upto": {
    accepts: buildSvmUptoAccept(),
    description: "SVM upto testnet endpoint",
    mimeType: "application/json",
  },
};

let wrappedGetPromise: Promise<(request: NextRequest) => Promise<NextResponse>> | null = null;

/**
 * Lazily builds the withX402-wrapped GET handler once the SVM `upto` scheme has been
 * registered (see {@link ensureSvmUptoRegistered}), then caches the wrapped handler so
 * `withX402`'s own lazy facilitator-sync/init logic only runs once per process — the
 * same as every other route in this family, which call `withX402` once at module scope.
 *
 * @returns The withX402-wrapped GET handler
 */
function getWrappedHandler(): Promise<(request: NextRequest) => Promise<NextResponse>> {
  if (!wrappedGetPromise) {
    wrappedGetPromise = ensureSvmUptoRegistered().then(() =>
      withJsonPaymentRequired(
        withX402(handler, routes, svmResourceServer),
        "To access this, register support for the SVM mechanism and the upto scheme " +
          "(payment-channels escrow flow), such as the canonical x402 SDKs " +
          "(@x402/svm), which do by default. This route authorizes 2x the advertised " +
          "price but settles only 50% of it.",
      ),
    );
  }
  return wrappedGetPromise;
}

/**
 * GET handler for the SVM `upto` testnet endpoint.
 *
 * @param request - Incoming Next.js request
 * @returns The withX402-processed response
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const wrapped = await getWrappedHandler();
  return wrapped(request);
}
