import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import {
  server,
  EVM_PAYEE_ADDRESS,
  EVM_NETWORK,
  EVM_AUTH_CAPTURE_CAPTURE_AUTHORIZER,
} from "@/proxy";

const handler = async (_: NextRequest) => {
  return NextResponse.json({
    message: "auth-capture endpoint accessed successfully (withX402)",
    timestamp: new Date().toISOString(),
  });
};

const unconfiguredHandler = async () =>
  NextResponse.json(
    { error: "auth-capture not configured: set EVM_AUTH_CAPTURE_CAPTURE_AUTHORIZER" },
    { status: 503 },
  );

/**
 * Protected auth-capture EVM endpoint (EIP-3009 transfer) using the withX402 wrapper.
 * Returns 503 if EVM_AUTH_CAPTURE_CAPTURE_AUTHORIZER is not set.
 */
export const GET = EVM_AUTH_CAPTURE_CAPTURE_AUTHORIZER
  ? withX402(
      handler,
      {
        accepts: {
          payTo: EVM_PAYEE_ADDRESS,
          scheme: "auth-capture",
          price: "$0.001",
          network: EVM_NETWORK,
          extra: {
            captureAuthorizer: EVM_AUTH_CAPTURE_CAPTURE_AUTHORIZER,
            captureDeadlineSeconds: 3600,
            refundDeadlineSeconds: 7200,
            feeRecipient: EVM_PAYEE_ADDRESS,
            minFeeBps: 0,
            maxFeeBps: 100,
            assetTransferMethod: "eip3009",
            autoCapture: true,
          },
        },
      },
      server,
    )
  : unconfiguredHandler;
