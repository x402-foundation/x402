/**
 * Example: Server with EIP-2612 Gas Sponsoring Extension
 *
 * This example demonstrates how to set up a server that supports the
 * Permit2 payment flow with EIP-2612 gasless approval. When a client
 * doesn't have an existing Permit2 approval, the facilitator will use
 * the client's EIP-2612 permit signature to approve Permit2 on-chain
 * as part of the settlement transaction.
 *
 * Required environment variables:
 * - EVM_ADDRESS: The payee wallet address
 * - FACILITATOR_URL: URL of the facilitator service
 */

import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { declareEip2612GasSponsoringExtension } from "@x402/extensions";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("Missing EVM_ADDRESS environment variable");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("Missing FACILITATOR_URL environment variable");
  process.exit(1);
}
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const app = express();

app.use(
  paymentMiddleware(
    {
      // This endpoint uses the Permit2 asset transfer method
      // and declares support for EIP-2612 gasless approval.
      // Clients that don't have an existing Permit2 approval can
      // use the EIP-2612 extension to get a gasless approval.
      "GET /premium-data": {
        accepts: {
          scheme: "exact",
          network: "eip155:84532",
          payTo: evmAddress,
          // Use pre-parsed price to force Permit2 flow
          price: {
            amount: "1000", // 0.001 USDC
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            extra: {
              assetTransferMethod: "permit2",
            },
          },
        },
        description: "Premium market data with gasless Permit2 approval",
        mimeType: "application/json",
        extensions: {
          // Advertise Bazaar discovery (optional)
          ...declareDiscoveryExtension({
            output: {
              example: { data: "premium market data" },
            },
          }),
          // Advertise EIP-2612 gas sponsoring support
          // This tells clients that the facilitator will accept an
          // EIP-2612 permit signature for gasless Permit2 approval
          ...declareEip2612GasSponsoringExtension(),
        },
      },
    },
    new x402ResourceServer(facilitatorClient).register("eip155:84532", new ExactEvmScheme()),
  ),
);

app.get("/premium-data", (req, res) => {
  res.json({
    data: "premium market data",
    timestamp: new Date().toISOString(),
  });
});

app.listen(4021, () => {
  console.log("Server with EIP-2612 Gas Sponsoring listening at http://localhost:4021");
});
