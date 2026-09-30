import { withX402 } from "@x402/next";
import { NextRequest, NextResponse } from "next/server";
import {
  buildExactErc3009Accept,
  evmResourceServer,
  SYNC_FACILITATOR_ON_START,
  withJsonPaymentRequired,
} from "@/lib/testnetProtectedResources";

/**
 * Testnet demo handler for the EVM `exact` / erc3009 endpoint.
 *
 * @param _ - Incoming Next.js request (unused; content is static)
 * @returns JSON confirmation of successful payment
 */
const handler = async (_: NextRequest): Promise<NextResponse> => {
  return NextResponse.json({
    ok: true,
    caip2Family: "evm",
    scheme: "exact",
    assetTransferMethod: "erc3009",
  });
};

export const GET = withJsonPaymentRequired(
  withX402(
    handler,
    {
      "GET /protected/evm/exact/erc3009": {
        accepts: buildExactErc3009Accept(),
        description: "EVM exact testnet endpoint (erc3009 only)",
        mimeType: "application/json",
      },
    },
    evmResourceServer,
    undefined,
    undefined,
    SYNC_FACILITATOR_ON_START,
  ),
  "To access this, register support for the EVM mechanism and use a client that " +
    "supports EIP-3009 (transferWithAuthorization), such as the canonical x402 SDKs " +
    "(@x402/evm), which do by default.",
);
