import { withX402 } from "@x402/next";
import { NextRequest, NextResponse } from "next/server";
import {
  buildExactPermit2Accept,
  evmResourceServer,
  SYNC_FACILITATOR_ON_START,
  withJsonPaymentRequired,
} from "@/lib/testnetProtectedResources";

/**
 * Testnet demo handler for the EVM `exact` / permit2 (no extension) endpoint.
 *
 * @param _ - Incoming Next.js request (unused; content is static)
 * @returns JSON confirmation of successful payment
 */
const handler = async (_: NextRequest): Promise<NextResponse> => {
  return NextResponse.json({
    ok: true,
    caip2Family: "evm",
    scheme: "exact",
    assetTransferMethod: "permit2",
  });
};

export const GET = withJsonPaymentRequired(
  withX402(
    handler,
    {
      "GET /protected/evm/exact/permit2": {
        accepts: buildExactPermit2Accept(),
        description: "EVM exact testnet endpoint (permit2, no gas-sponsoring extension)",
        mimeType: "application/json",
      },
    },
    evmResourceServer,
    undefined,
    undefined,
    SYNC_FACILITATOR_ON_START,
  ),
  "To access this, register support for the EVM mechanism and use a client that " +
    "supports Permit2, such as the canonical x402 SDKs (@x402/evm). This route does " +
    "not offer gasless approval, so the paying account must already have approved " +
    "the canonical Permit2 contract to spend the token.",
);
