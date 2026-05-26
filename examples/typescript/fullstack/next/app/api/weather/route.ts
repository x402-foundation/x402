import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { server, paywall, evmAddress, svmAddress } from "../../../proxy";

/**
 * Weather API endpoint handler
 *
 * This handler returns weather data after payment verification.
 * Payment is only settled after a successful response (status < 400).
 *
 * @param _ - Incoming Next.js request
 * @returns JSON response with weather data
 */
const handler = async (_: NextRequest) => {
  return NextResponse.json(
    {
      report: {
        weather: "sunny",
        temperature: 72,
      },
    },
    { status: 200 },
  );
};

/**
 * Protected weather API endpoint using withX402 wrapper
 *
 * This demonstrates the v2 withX402 wrapper for individual API routes.
 * Unlike middleware, withX402 guarantees payment settlement only after
 * the handler returns a successful response (status < 400).
 */
export const GET = withX402(
  handler,
  {
    accepts: [
      {
        scheme: "exact",
        price: "$0.001",
        network: "eip155:84532", // base-sepolia
        payTo: evmAddress,
      },
      {
        scheme: "exact",
        price: "$0.001",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", // solana devnet
        payTo: svmAddress,
      },
    ],
    description: "Access to weather API",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        output: {
          example: {
            report: {
              weather: "sunny",
              temperature: 72,
            },
          },
        },
      }),
    },
  },
  server,
  undefined, // paywallConfig (using custom paywall from proxy.ts)
  paywall,
);
