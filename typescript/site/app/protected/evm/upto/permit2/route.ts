import { setSettlementOverrides, withX402 } from "@x402/next";
import { NextRequest, NextResponse } from "next/server";
import {
  buildUptoAccept,
  evmResourceServer,
  SYNC_FACILITATOR_ON_START,
  UPTO_SETTLEMENT_OVERRIDE,
  withJsonPaymentRequired,
} from "@/lib/testnetProtectedResources";

/**
 * Testnet demo handler for the EVM `upto` / permit2 (no extension) endpoint. Authorizes
 * 2x the exact price but settles only {@link UPTO_SETTLEMENT_OVERRIDE} of it.
 *
 * @param _ - Incoming Next.js request (unused; content is static)
 * @returns JSON confirmation of successful payment, with the settlement override applied
 */
const handler = async (_: NextRequest): Promise<NextResponse> => {
  const response = NextResponse.json({
    ok: true,
    caip2Family: "evm",
    scheme: "upto",
    assetTransferMethod: "permit2",
    settledPercentOfAuthorized: UPTO_SETTLEMENT_OVERRIDE,
  });
  setSettlementOverrides(response, { amount: UPTO_SETTLEMENT_OVERRIDE });
  return response;
};

export const GET = withJsonPaymentRequired(
  withX402(
    handler,
    {
      "GET /protected/evm/upto/permit2": {
        accepts: buildUptoAccept(),
        description: "EVM upto testnet endpoint (permit2, no gas-sponsoring extension)",
        mimeType: "application/json",
      },
    },
    evmResourceServer,
    undefined,
    undefined,
    SYNC_FACILITATOR_ON_START,
  ),
  "To access this, register support for the EVM mechanism and the upto scheme, and " +
    "use a client that supports Permit2 and partial settlement, such as the " +
    "canonical x402 SDKs (@x402/evm). This route does not offer gasless approval, so " +
    "the paying account must already have approved the canonical Permit2 contract. " +
    "This route authorizes 2x the advertised price but settles only 50% of it.",
);
