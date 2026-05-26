import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { server, EVM_PAYEE_ADDRESS, EVM_NETWORK } from "@/proxy";

const handler = async (_: NextRequest) => {
  return NextResponse.json({
    message: "Batch-settlement endpoint accessed successfully (withX402)",
    timestamp: new Date().toISOString(),
  });
};

/**
 * Protected batch-settlement EVM endpoint using the withX402 wrapper.
 */
export const GET = withX402(
  handler,
  {
    accepts: {
      payTo: EVM_PAYEE_ADDRESS,
      scheme: "batch-settlement",
      price: "$0.001",
      network: EVM_NETWORK,
    },
  },
  server,
);
