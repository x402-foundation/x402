import { NextRequest, NextResponse } from "next/server";
import { withX402, setSettlementOverrides } from "@x402/next";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

import { evmAddress, NETWORK, server } from "../../../lib/server";

// Authorize up to this amount per request; handler bills a random fraction via setSettlementOverrides.
const maxPrice = "$0.01";

/**
 * Weather API handler for the batch-settlement Next example (API-only; no paywall HTML).
 *
 * The client authorizes up to maxPrice, but settlement charges only actual usage
 * via setSettlementOverrides.
 *
 * @param _ - Incoming Next.js request
 * @returns JSON response with weather data
 */
const handler = async (_: NextRequest) => {
  const chargedPercent = 1 + Math.floor(Math.random() * 100);

  const response = NextResponse.json({
    report: {
      weather: "sunny",
      temperature: 72,
    },
    usage: {
      authorizedMax: maxPrice,
      chargedPercent,
    },
  });

  setSettlementOverrides(response, { amount: `${chargedPercent}%` });

  return response;
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
        price: maxPrice,
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
