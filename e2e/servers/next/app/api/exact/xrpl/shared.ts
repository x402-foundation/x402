import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import type { XrplAssetTransferMethod } from "@x402/xrpl";
import { createXrplPaymentConfig, server, XRPL_PAYEE_ADDRESS } from "@/proxy";

/**
 * Return the common successful response for XRPL payment routes.
 *
 * @param _ - Incoming request (unused by the response handler)
 * @returns JSON response confirming access to the protected endpoint
 */
export const xrplHandler = async (_: NextRequest) => {
  return NextResponse.json({
    message: "Protected XRPL endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  });
};

/**
 * Create an XRPL route handler protected by the requested transfer method.
 *
 * @param assetTransferMethod - XRPL sequence mode to advertise in payment requirements
 * @returns A protected route handler, or a 503 handler when XRPL is not configured
 */
export function createXrplWithX402Handler(assetTransferMethod: XrplAssetTransferMethod) {
  return XRPL_PAYEE_ADDRESS
    ? withX402(
        xrplHandler,
        createXrplPaymentConfig(XRPL_PAYEE_ADDRESS, assetTransferMethod),
        server,
      )
    : async () => {
        return NextResponse.json({ error: "XRPL not configured" }, { status: 503 });
      };
}
