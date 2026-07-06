import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { server, XRPL_PAYEE_ADDRESS, XRPL_NETWORK, XRPL_ASSET, XRPL_AMOUNT } from "@/proxy";

/**
 * Handler for the protected endpoint
 */
const handler = async (_: NextRequest) => {
  return NextResponse.json({
    message: "Protected XRPL endpoint accessed successfully (withX402)",
    timestamp: new Date().toISOString(),
  });
};

/**
 * Protected XRPL endpoint using withX402 wrapper
 * Only exported if XRPL_PAYEE_ADDRESS is configured
 */
export const GET = XRPL_PAYEE_ADDRESS
  ? withX402(
      handler,
      {
        accepts: {
          payTo: XRPL_PAYEE_ADDRESS,
          scheme: "exact",
          price: {
            amount: XRPL_AMOUNT || "1000",
            asset: XRPL_ASSET || "XRP",
          },
          network: XRPL_NETWORK,
        },
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                message: "Protected XRPL endpoint accessed successfully (withX402)",
                timestamp: "2024-01-01T00:00:00Z",
              },
              schema: {
                properties: {
                  message: { type: "string" },
                  timestamp: { type: "string" },
                },
                required: ["message", "timestamp"],
              },
            },
          }),
        },
      },
      server,
    )
  : async () => {
      return NextResponse.json({ error: "XRPL not configured" }, { status: 503 });
    };
