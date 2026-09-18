import { withX402 } from "@x402/next";
import { NextRequest, NextResponse } from "next/server";
import {
  buildExactPermit2Accept,
  EIP2612_EXTENSION,
  evmResourceServer,
  SYNC_FACILITATOR_ON_START,
  withJsonPaymentRequired,
} from "@/lib/testnetProtectedResources";

/**
 * Testnet demo handler for the EVM `exact` / permit2 / eip2612 endpoint.
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
    extension: "eip2612GasSponsoring",
  });
};

export const GET = withJsonPaymentRequired(
  withX402(
    handler,
    {
      "GET /protected/evm/exact/permit2/eip2612": {
        accepts: buildExactPermit2Accept(),
        description: "EVM exact testnet endpoint (permit2 with gasless EIP-2612 approval)",
        mimeType: "application/json",
        extensions: {
          ...EIP2612_EXTENSION,
        },
      },
    },
    evmResourceServer,
    undefined,
    undefined,
    SYNC_FACILITATOR_ON_START,
  ),
  "To access this, register support for the EVM mechanism and use a client that " +
    "supports Permit2 with EIP-2612 gasless approval, such as the canonical x402 " +
    "SDKs (@x402/evm), which do by default.",
);
