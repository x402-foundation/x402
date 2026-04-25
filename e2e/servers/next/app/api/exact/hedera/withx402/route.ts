import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  server,
  HEDERA_PAYEE_ADDRESS,
  HEDERA_NETWORK,
  HEDERA_ASSET,
  HEDERA_AMOUNT,
} from "../../../../../proxy";

/**
 * Handler for the protected endpoint
 */
const handler = async (_: NextRequest) => {
  return NextResponse.json({
    message: "Protected Hedera endpoint accessed successfully (withX402)",
    timestamp: new Date().toISOString(),
  });
};

/**
 * Protected Hedera endpoint using withX402 wrapper
 * Only exported if HEDERA_PAYEE_ADDRESS is configured
 */
export const GET = HEDERA_PAYEE_ADDRESS
  ? withX402(
      handler,
      {
        accepts: {
          payTo: HEDERA_PAYEE_ADDRESS,
          scheme: "exact",
          price: {
            amount: HEDERA_AMOUNT,
            asset: HEDERA_ASSET,
          },
          network: HEDERA_NETWORK,
        },
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                message: "Protected Hedera endpoint accessed successfully (withX402)",
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
      return NextResponse.json(
        { error: "Hedera not configured" },
        { status: 503 },
      );
    };
