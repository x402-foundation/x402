import { HTTPFacilitatorClient } from "@x402/core/server";
import { AuthCaptureEvmScheme } from "@x402/evm/auth-capture/server";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/express";
import { config } from "dotenv";
import express from "express";
import { getAddress, zeroAddress } from "viem";

config();

const NETWORK = "eip155:84532" as const;
const PORT = 4021;

const payTo = process.env.EVM_ADDRESS?.trim();
const facilitatorUrl = process.env.FACILITATOR_URL?.trim();
const customOperatorAddress = process.env.CUSTOM_OPERATOR_ADDRESS?.trim() as
  | `0x${string}`
  | undefined;

if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
  console.error("Missing or invalid EVM_ADDRESS (checksummed 20-byte hex, 0x-prefixed)");
  process.exit(1);
}

if (!facilitatorUrl) {
  console.error("Missing required FACILITATOR_URL environment variable");
  process.exit(1);
}

if (!customOperatorAddress || !/^0x[0-9a-fA-F]{40}$/.test(customOperatorAddress)) {
  console.error(
    "Missing or invalid CUSTOM_OPERATOR_ADDRESS (deploy a custom operator and allowlist it on the facilitator)",
  );
  process.exit(1);
}

const payToAddress = getAddress(payTo) as `0x${string}`;
const captureAuthorizer = getAddress(customOperatorAddress) as `0x${string}`;

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const scheme = new AuthCaptureEvmScheme();

const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, scheme);
const httpServer = new x402HTTPResourceServer(resourceServer, {
  "GET /weather": {
    accepts: {
      scheme: "auth-capture",
      price: "$0.01",
      network: NETWORK,
      payTo: payToAddress,
      extra: {
        feeRecipient: zeroAddress,
        minFeeBps: 0,
        maxFeeBps: 0,
        captureDeadlineSeconds: 3600,
        refundDeadlineSeconds: 7200,
        captureAuthorizer,
        operatorType: "custom",
        paymentFlow: "escrow",
        captureMode: "deferred",
      },
    },
    description: "Weather data",
    mimeType: "application/json",
  },
});

const app = express();

/**
 * Starts the resource server for the custom escrow, deferred capture flow.
 */
async function main(): Promise<void> {
  await httpServer.initialize();

  app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));

  app.get("/weather", (_req, res) => {
    res.send({
      report: {
        weather: "sunny",
        temperature: 70,
        flow: "custom-escrow",
      },
    });
  });

  app.listen(PORT, () => {
    console.log(`Auth-capture server (custom-escrow) listening at http://localhost:${PORT}`);
    console.log("  GET /weather");
    console.log(`  Custom operator: ${captureAuthorizer}`);
    console.log("  Collect-only: capture/void/refund run out of band on the operator contract.");
  });
}

main().catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});
