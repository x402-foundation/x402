import { setSettlementOverrides, withX402 } from "@x402/next";
import { NextRequest, NextResponse } from "next/server";
import {
  buildUptoAccept,
  EIP2612_EXTENSION,
  evmResourceServer,
  SYNC_FACILITATOR_ON_START,
  UPTO_SETTLEMENT_OVERRIDE,
  withJsonPaymentRequired,
} from "@/lib/testnetProtectedResources";

/**
 * Testnet demo handler for the EVM `upto` default endpoint. Authorizes 2x the exact
 * price but settles only {@link UPTO_SETTLEMENT_OVERRIDE} of it.
 *
 * @param _ - Incoming Next.js request (unused; content is static)
 * @returns JSON confirmation of successful payment, with the settlement override applied
 */
const handler = async (_: NextRequest): Promise<NextResponse> => {
  const response = NextResponse.json({
    ok: true,
    caip2Family: "evm",
    scheme: "upto",
    settledPercentOfAuthorized: UPTO_SETTLEMENT_OVERRIDE,
  });
  setSettlementOverrides(response, { amount: UPTO_SETTLEMENT_OVERRIDE });
  return response;
};

export const GET = withJsonPaymentRequired(
  withX402(
    handler,
    {
      "GET /protected/evm/upto": {
        accepts: buildUptoAccept(),
        description: "EVM upto testnet endpoint (permit2 with gasless EIP-2612 approval)",
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
  "To access this, register support for the EVM mechanism and the upto scheme, and " +
    "use a client that supports Permit2 with EIP-2612 gasless approval and partial " +
    "settlement, such as the canonical x402 SDKs (@x402/evm), which do by default. " +
    "This route authorizes 2x the advertised price but settles only 50% of it.",
);
