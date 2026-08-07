import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { server, NEAR_PAYEE_ADDRESS, NEAR_NETWORK, NEAR_ASSET, NEAR_AMOUNT } from "@/proxy";

/**
 * Handler for the protected endpoint
 */
const handler = async (_: NextRequest) => {
  return NextResponse.json({
    message: "Protected NEAR endpoint accessed successfully (withX402)",
    timestamp: new Date().toISOString(),
  });
};

/**
 * Protected NEAR endpoint using withX402 wrapper
 * Only exported if NEAR_PAYEE_ADDRESS is configured
 */
export const GET = NEAR_PAYEE_ADDRESS
  ? withX402(
      handler,
      {
        accepts: {
          payTo: NEAR_PAYEE_ADDRESS,
          scheme: "exact",
          price: {
            amount: NEAR_AMOUNT || "1000000000000000000000",
            asset: NEAR_ASSET || "wrap.testnet",
          },
          network: NEAR_NETWORK,
        },
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                message: "Protected NEAR endpoint accessed successfully (withX402)",
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
      return NextResponse.json({ error: "NEAR not configured" }, { status: 503 });
    };
