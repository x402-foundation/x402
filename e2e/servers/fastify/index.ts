import Fastify from "fastify";
import { paymentMiddleware, setSettlementOverrides } from "@x402/fastify";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactAptosScheme } from "@x402/aptos/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  declareEip2612GasSponsoringExtension,
  declareErc20ApprovalGasSponsoringExtension,
} from "@x402/extensions";
import dotenv from "dotenv";

dotenv.config();

/**
 * Fastify E2E Test Server with x402 Payment Middleware
 *
 * This server demonstrates how to integrate x402 payment middleware
 * with a Fastify application for end-to-end testing.
 */

const PORT = process.env.PORT || "4024";
const EVM_NETWORK = (process.env.EVM_NETWORK || "eip155:84532") as `${string}:${string}`;
const SVM_NETWORK = (process.env.SVM_NETWORK ||
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1") as `${string}:${string}`;
const APTOS_NETWORK = (process.env.APTOS_NETWORK || "aptos:2") as `${string}:${string}`;
const STELLAR_NETWORK = (process.env.STELLAR_NETWORK || "stellar:testnet") as `${string}:${string}`;
const EVM_PAYEE_ADDRESS = process.env.EVM_PAYEE_ADDRESS as `0x${string}`;
const SVM_PAYEE_ADDRESS = process.env.SVM_PAYEE_ADDRESS as string;
const EVM_PERMIT2_ASSET = process.env.EVM_PERMIT2_ASSET as `0x${string}`;
const APTOS_PAYEE_ADDRESS = process.env.APTOS_PAYEE_ADDRESS as string;
const STELLAR_PAYEE_ADDRESS = process.env.STELLAR_PAYEE_ADDRESS as string | undefined;
const facilitatorUrl = process.env.FACILITATOR_URL;

if (!EVM_PAYEE_ADDRESS) {
  console.error("❌ EVM_PAYEE_ADDRESS environment variable is required");
  process.exit(1);
}

if (!SVM_PAYEE_ADDRESS) {
  console.error("❌ SVM_PAYEE_ADDRESS environment variable is required");
  process.exit(1);
}

if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}

// Initialize Fastify app
const app = Fastify();

// Create HTTP facilitator client
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// Create x402 resource server
const server = new x402ResourceServer(facilitatorClient);

// Register server schemes
server.register("eip155:*", new ExactEvmScheme());
server.register("eip155:*", new UptoEvmScheme());
server.register("solana:*", new ExactSvmScheme());
if (APTOS_PAYEE_ADDRESS) {
  server.register("aptos:*", new ExactAptosScheme());
}
if (STELLAR_PAYEE_ADDRESS) {
  server.register("stellar:*", new ExactStellarScheme());
}

// Register Bazaar discovery extension
server.registerExtension(bazaarResourceServerExtension);

console.log(
  `Facilitator account: ${process.env.EVM_PRIVATE_KEY ? process.env.EVM_PRIVATE_KEY.substring(0, 10) + "..." : "not configured"}`,
);
console.log(`Using remote facilitator at: ${facilitatorUrl}`);

/**
 * Pre-middleware guard for optional Aptos / Stellar endpoints
 * Returns 501 Not Implemented if not configured
 */
app.addHook("onRequest", async (request, reply) => {
  const path = request.url.split("?")[0];
  if (path === "/exact/aptos" && !APTOS_PAYEE_ADDRESS) {
    return reply.status(501).send({
      error: "Aptos payments not configured",
      message: "APTOS_PAYEE_ADDRESS environment variable is not set",
    });
  }
  if (path.startsWith("/exact/stellar") && !STELLAR_PAYEE_ADDRESS) {
    return reply.status(501).send({
      error: "Stellar payments not configured",
      message: "STELLAR_PAYEE_ADDRESS environment variable is not set",
    });
  }
});

/**
 * Configure x402 payment middleware using builder pattern
 *
 * This middleware protects endpoints with $0.001 USDC payment requirements
 * on Base Sepolia, Solana Devnet, Aptos Testnet, and Stellar Testnet with bazaar discovery extension.
 */
paymentMiddleware(
  app,
  {
    // Route-specific payment configuration
    "GET /exact/evm/eip3009": {
      accepts: {
        payTo: EVM_PAYEE_ADDRESS,
        scheme: "exact",
        price: "$0.001",
        network: EVM_NETWORK,
      },
      extensions: {
        ...declareDiscoveryExtension({
          output: {
            example: {
              message: "Protected endpoint accessed successfully",
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
    "GET /exact/svm": {
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
              message: "Protected endpoint accessed successfully",
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
    ...(APTOS_PAYEE_ADDRESS
      ? {
          "GET /exact/aptos": {
            accepts: {
              payTo: APTOS_PAYEE_ADDRESS,
              scheme: "exact",
              price: "$0.001",
              network: APTOS_NETWORK,
            },
            extensions: {
              ...declareDiscoveryExtension({
                output: {
                  example: {
                    message: "Protected endpoint accessed successfully",
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
        }
      : {}),
    // Permit2 standard/direct endpoint - no gas sponsoring, client must pre-approve Permit2
    "GET /exact/evm/permit2": {
      accepts: {
        payTo: EVM_PAYEE_ADDRESS,
        scheme: "exact",
        network: EVM_NETWORK,
        price: {
          amount: "1000",
          asset: EVM_PERMIT2_ASSET,
          extra: {
            assetTransferMethod: "permit2",
            name: EVM_NETWORK == "eip155:84532" ? "USDC" : "USD Coin",
            version: "2",
          },
        },
      },
      extensions: {
        ...declareDiscoveryExtension({
          output: {
            example: {
              message: "Permit2 endpoint accessed successfully",
              timestamp: "2024-01-01T00:00:00Z",
              method: "permit2",
            },
            schema: {
              properties: {
                message: { type: "string" },
                timestamp: { type: "string" },
                method: { type: "string" },
              },
              required: ["message", "timestamp", "method"],
            },
          },
        }),
      },
    },
    // Permit2 endpoint with EIP-2612 gas sponsoring
    "GET /exact/evm/permit2-eip2612GasSponsoring": {
      accepts: {
        payTo: EVM_PAYEE_ADDRESS,
        scheme: "exact",
        network: EVM_NETWORK,
        price: "$0.001",
        extra: { assetTransferMethod: "permit2" },
      },
      extensions: {
        ...declareDiscoveryExtension({
          output: {
            example: {
              message: "Permit2 EIP-2612 endpoint accessed successfully",
              timestamp: "2024-01-01T00:00:00Z",
              method: "permit2-eip2612",
            },
            schema: {
              properties: {
                message: { type: "string" },
                timestamp: { type: "string" },
                method: { type: "string" },
              },
              required: ["message", "timestamp", "method"],
            },
          },
        }),
        ...declareEip2612GasSponsoringExtension(),
      },
    },
    // Permit2 endpoint for ERC-20 approval gas sponsoring (no EIP-2612)
    "GET /exact/evm/permit2-erc20ApprovalGasSponsoring": {
      accepts: {
        payTo: EVM_PAYEE_ADDRESS,
        scheme: "exact",
        network: EVM_NETWORK,
        price: {
          amount: "1000",
          asset: EVM_PERMIT2_ASSET,
          extra: {
            assetTransferMethod: "permit2",
          },
        },
      },
      extensions: {
        ...declareErc20ApprovalGasSponsoringExtension(),
      },
    },
    // Upto Permit2 direct endpoint - client must have Permit2 pre-approved
    "GET /upto/evm/permit2": {
      accepts: {
        payTo: EVM_PAYEE_ADDRESS,
        scheme: "upto",
        network: EVM_NETWORK,
        price: {
          amount: "2000",
          asset: EVM_PERMIT2_ASSET,
          extra: {
            assetTransferMethod: "permit2",
            name: EVM_NETWORK == "eip155:84532" ? "USDC" : "USD Coin",
            version: "2",
          },
        },
      },
    },
    // Upto Permit2 endpoint with EIP-2612 gas sponsoring
    "GET /upto/evm/permit2-eip2612GasSponsoring": {
      accepts: {
        payTo: EVM_PAYEE_ADDRESS,
        scheme: "upto",
        network: EVM_NETWORK,
        price: {
          amount: "2000",
          asset: EVM_PERMIT2_ASSET,
          extra: {
            assetTransferMethod: "permit2",
            name: EVM_NETWORK == "eip155:84532" ? "USDC" : "USD Coin",
            version: "2",
          },
        },
      },
      extensions: {
        ...declareEip2612GasSponsoringExtension(),
      },
    },
    // Upto Permit2 endpoint for ERC-20 approval gas sponsoring
    "GET /upto/evm/permit2-erc20ApprovalGasSponsoring": {
      accepts: {
        payTo: EVM_PAYEE_ADDRESS,
        scheme: "upto",
        network: EVM_NETWORK,
        price: {
          amount: "2000",
          asset: EVM_PERMIT2_ASSET,
          extra: {
            assetTransferMethod: "permit2",
          },
        },
      },
      extensions: {
        ...declareErc20ApprovalGasSponsoringExtension(),
      },
    },
    ...(STELLAR_PAYEE_ADDRESS
      ? {
          "GET /exact/stellar": {
            accepts: {
              payTo: STELLAR_PAYEE_ADDRESS!,
              scheme: "exact",
              price: "$0.001",
              network: STELLAR_NETWORK,
            },
            extensions: {
              ...declareDiscoveryExtension({
                output: {
                  example: {
                    message: "Protected Stellar endpoint accessed successfully",
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
        }
      : {}),
  },
  server, // Pass pre-configured server instance
);

/**
 * Protected endpoint - requires payment to access
 *
 * This endpoint demonstrates a resource protected by x402 payment middleware.
 * Clients must provide a valid payment signature to access this endpoint.
 */
app.get("/exact/evm/eip3009", async () => {
  return {
    message: "Protected endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  };
});

/**
 * Protected SVM endpoint - requires payment to access
 *
 * This endpoint demonstrates a resource protected by x402 payment middleware for SVM.
 * Clients must provide a valid payment signature to access this endpoint.
 */
app.get("/exact/svm", async () => {
  return {
    message: "Protected endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  };
});

/**
 * Protected Aptos endpoint - requires payment to access
 *
 * This endpoint demonstrates a resource protected by x402 payment middleware for Aptos.
 * Clients must provide a valid payment signature to access this endpoint.
 * Note: 501 check is handled by pre-middleware guard above.
 */
app.get("/exact/aptos", async () => {
  return {
    message: "Protected endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  };
});

/**
 * Protected Permit2 endpoint - standard settle (no gas sponsoring)
 */
app.get("/exact/evm/permit2", async () => {
  return {
    message: "Permit2 endpoint accessed successfully",
    timestamp: new Date().toISOString(),
    method: "permit2",
  };
});

/**
 * Protected Permit2 EIP-2612 endpoint - requires Permit2 with gas sponsoring
 */
app.get("/exact/evm/permit2-eip2612GasSponsoring", async () => {
  return {
    message: "Permit2 EIP-2612 endpoint accessed successfully",
    timestamp: new Date().toISOString(),
    method: "permit2-eip2612",
  };
});

/**
 * Protected Permit2 ERC-20 endpoint - requires payment via Permit2 flow with ERC-20 approval
 *
 * This endpoint demonstrates the ERC-20 approval gas sponsoring flow for tokens
 * that do NOT implement EIP-2612. The facilitator broadcasts the pre-signed
 * approve() transaction on the client's behalf before settling.
 */
app.get("/exact/evm/permit2-erc20ApprovalGasSponsoring", async () => {
  return {
    message: "Permit2 ERC-20 approval endpoint accessed successfully",
    timestamp: new Date().toISOString(),
    method: "permit2-erc20-approval",
  };
});

/**
 * Upto Permit2 direct endpoint - upto scheme, client must pre-approve Permit2
 */
app.get("/upto/evm/permit2", async (_request, reply) => {
  setSettlementOverrides(reply, { amount: "1000" });
  return {
    message: "Upto Permit2 endpoint accessed successfully",
    timestamp: new Date().toISOString(),
    method: "upto-permit2",
  };
});

/**
 * Upto Permit2 EIP-2612 endpoint - upto scheme with gas sponsoring
 */
app.get("/upto/evm/permit2-eip2612GasSponsoring", async (_request, reply) => {
  setSettlementOverrides(reply, { amount: "1000" });
  return {
    message: "Upto Permit2 EIP-2612 endpoint accessed successfully",
    timestamp: new Date().toISOString(),
    method: "upto-permit2-eip2612",
  };
});

/**
 * Upto Permit2 ERC-20 approval endpoint - upto scheme with ERC-20 gas sponsoring
 */
app.get("/upto/evm/permit2-erc20ApprovalGasSponsoring", async (_request, reply) => {
  setSettlementOverrides(reply, { amount: "1000" });
  return {
    message: "Upto Permit2 ERC-20 approval endpoint accessed successfully",
    timestamp: new Date().toISOString(),
    method: "upto-permit2-erc20-approval",
  };
});

/**
 * Protected Stellar endpoint - requires payment to access
 *
 * This endpoint demonstrates a resource protected by x402 payment middleware for Stellar.
 * Clients must provide a valid payment signature to access this endpoint.
 * Note: 501 check is handled by pre-middleware guard above.
 */
if (STELLAR_PAYEE_ADDRESS) {
  app.get("/exact/stellar", async () => {
    return {
      message: "Protected Stellar endpoint accessed successfully",
      timestamp: new Date().toISOString(),
    };
  });
}

/**
 * Health check endpoint - no payment required
 *
 * Used to verify the server is running and responsive.
 */
app.get("/health", async () => {
  return {
    status: "ok",
    network: EVM_NETWORK,
    payee: EVM_PAYEE_ADDRESS,
    version: "2.0.0",
  };
});

/**
 * Shutdown endpoint - used by e2e tests
 *
 * Allows graceful shutdown of the server during testing.
 */
app.post("/close", async (request, reply) => {
  reply.send({ message: "Server shutting down gracefully" });
  console.log("Received shutdown request");

  // Give time for response to be sent
  setTimeout(() => {
    process.exit(0);
  }, 100);
});

// Start the server
app.listen({ port: parseInt(PORT) }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`
╔════════════════════════════════════════════════════════╗
║           x402 Fastify E2E Test Server                 ║
╠════════════════════════════════════════════════════════╣
║  Server:       ${address}                              ║
║  EVM Network:  ${EVM_NETWORK}                          ║
║  SVM Network:  ${SVM_NETWORK}                          ║
║  Aptos Network: ${APTOS_NETWORK}                       ║
║  Stellar Network: ${STELLAR_NETWORK}║
║  EVM Payee:    ${EVM_PAYEE_ADDRESS}                    ║
║  SVM Payee:    ${SVM_PAYEE_ADDRESS}                    ║
║  Aptos Payee:  ${APTOS_PAYEE_ADDRESS || "(not configured)"}
║  Stellar Payee: ${STELLAR_PAYEE_ADDRESS || "(not configured)"}
║                                                        ║
║  Endpoints:                                            ║
║  • GET  /exact/evm/eip3009                    (EVM EIP-3009)  ║
║  • GET  /exact/evm/permit2                    (Permit2)       ║
║  • GET  /exact/evm/permit2-eip2612GasSponsoring               ║
║  • GET  /exact/evm/permit2-erc20ApprovalGasSponsoring         ║
║  • GET  /exact/svm                            (SVM)           ║
║  • GET  /exact/aptos                          (Aptos)         ║
║  • GET  /exact/stellar                        (Stellar)       ║
║  • GET  /health                (no payment required)       ║
║  • POST /close                 (shutdown server)           ║
╚════════════════════════════════════════════════════════╝
  `);
});
