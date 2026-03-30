/**
 * All Networks Server Example
 *
 * Demonstrates how to create a server that supports all available networks with
 * optional chain configuration via environment variables.
 *
 * New chain support should be added here in alphabetic order by network prefix
 * (e.g., "eip155" before "solana" before "stellar").
 */

import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

config();

// Configuration - optional per network
const evmAddress = process.env.EVM_ADDRESS as `0x${string}` | undefined;
const svmAddress = process.env.SVM_ADDRESS as string | undefined;
const stellarAddress = process.env.STELLAR_ADDRESS as string | undefined;

// Validate at least one address is provided
if (!evmAddress && !svmAddress && !stellarAddress) {
  console.error("❌ At least one of EVM_ADDRESS, SVM_ADDRESS, or STELLAR_ADDRESS is required");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}

// Network configuration
const EVM_NETWORK = "eip155:84532" as const; // Base Sepolia
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const; // Solana Devnet
const STELLAR_NETWORK = "stellar:testnet" as const; // Stellar Testnet

// Build accepts array dynamically based on configured addresses
const accepts: Array<{
  scheme: string;
  price: string;
  network: `${string}:${string}`;
  payTo: string;
}> = [];
if (evmAddress) {
  accepts.push({
    scheme: "exact",
    price: "$0.001",
    network: EVM_NETWORK,
    payTo: evmAddress,
  });
}
if (svmAddress) {
  accepts.push({
    scheme: "exact",
    price: "$0.001",
    network: SVM_NETWORK,
    payTo: svmAddress,
  });
}
if (stellarAddress) {
  accepts.push({
    scheme: "exact",
    price: "$0.001",
    network: STELLAR_NETWORK,
    payTo: stellarAddress,
  });
}

// Create facilitator client
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// Create x402 resource server and register schemes dynamically
const server = new x402ResourceServer(facilitatorClient);
if (evmAddress) {
  server.register(EVM_NETWORK, new ExactEvmScheme());
}
if (svmAddress) {
  server.register(SVM_NETWORK, new ExactSvmScheme());
}
if (stellarAddress) {
  server.register(STELLAR_NETWORK, new ExactStellarScheme());
}

// Create Express app
const app = express();

// Apply payment middleware
app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts,
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    server,
  ),
);

// Protected endpoint
app.get("/weather", (req, res) => {
  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

// Health check (no payment required)
app.get("/health", (req, res) => {
  res.send({ status: "ok" });
});

// Start server
const port = process.env.PORT || 4021;
app.listen(port, () => {
  console.log(`🚀 All Networks Server listening at http://localhost:${port}`);
  if (evmAddress) {
    console.log(`   EVM: ${evmAddress} on ${EVM_NETWORK}`);
  }
  if (svmAddress) {
    console.log(`   SVM: ${svmAddress} on ${SVM_NETWORK}`);
  }
  if (stellarAddress) {
    console.log(`   Stellar: ${stellarAddress} on ${STELLAR_NETWORK}`);
  }
  console.log(`   Facilitator: ${facilitatorUrl}`);
  console.log();
});
