import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import {
  server,
  EVM_PAYEE_ADDRESS,
  EVM_NETWORK,
  EVM_AUTHCAPTURE_CAPTURE_AUTHORIZER,
} from "@/proxy";

const handler = async (_: NextRequest) => {
  return NextResponse.json({
    message: "authCapture endpoint accessed successfully (withX402)",
    timestamp: new Date().toISOString(),
  });
};

const unconfiguredHandler = async () =>
  NextResponse.json(
    { error: "authCapture not configured: set EVM_AUTHCAPTURE_CAPTURE_AUTHORIZER" },
    { status: 503 },
  );

/**
 * Protected authCapture EVM endpoint (EIP-3009 transfer) using the withX402 wrapper.
 * Returns 503 if EVM_AUTHCAPTURE_CAPTURE_AUTHORIZER is not set.
 */
export const GET = EVM_AUTHCAPTURE_CAPTURE_AUTHORIZER
  ? withX402(
      handler,
      {
        accepts: {
          payTo: EVM_PAYEE_ADDRESS,
          scheme: "authCapture",
          price: "$0.001",
          network: EVM_NETWORK,
          extra: {
            captureAuthorizer: EVM_AUTHCAPTURE_CAPTURE_AUTHORIZER,
            captureDeadline: Math.floor(Date.now() / 1000) + 3600,
            refundDeadline: Math.floor(Date.now() / 1000) + 7200,
            feeRecipient: EVM_PAYEE_ADDRESS,
            minFeeBps: 0,
            maxFeeBps: 100,
            name: "USDC",
            version: "2",
            assetTransferMethod: "eip3009",
            autoCapture: true,
          },
        },
      },
      server,
    )
  : unconfiguredHandler;
