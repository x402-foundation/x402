import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { server, SVM_PAYEE_ADDRESS, SVM_NETWORK } from "../../../proxy";

/**
 * Handler for the protected endpoint
 */
const handler = async (_: NextRequest) => {
  return NextResponse.json({
    message: "Protected endpoint accessed successfully (withX402)",
    timestamp: new Date().toISOString(),
  });
};

/**
 * Protected SVM endpoint using withX402 wrapper
 */
export const GET = withX402(
  handler,
  {
    accepts: {
      payTo: SVM_PAYEE_ADDRESS,
      scheme: "exact",
      price: "$0.001",
      network: SVM_NETWORK,
    },
    extensions: {
      ...declareDiscoveryExtension({
        output: {
          example: {
            message: "Protected endpoint accessed successfully (withX402)",
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
);
