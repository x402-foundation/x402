import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

import { evmAddress, NETWORK, server } from "../../../lib/server";

const price = "$0.001";

/**
 * Weather API handler for the batch-settlement Next example (API-only; no paywall HTML).
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
 * Protected weather API using `withX402` and batch-settlement (mirrors `fullstack/next` weather shape).
 */
export const GET = withX402(
  handler,
  {
    accepts: [
      {
        scheme: "batch-settlement",
        price,
        network: NETWORK,
        payTo: evmAddress,
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
);
