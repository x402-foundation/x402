import Fastify from "fastify";
import { paymentMiddleware, setSettlementOverrides } from "@x402/fastify";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactAptosScheme } from "@x402/aptos/exact/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { KEETA_TESTNET_CAIP2 } from "@x402/keeta";
import { ExactKeetaScheme } from "@x402/keeta/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { ExactTvmScheme } from "@x402/tvm/exact/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { ExactNearScheme } from "@x402/near/exact/server";
import type { XrplAssetTransferMethod } from "@x402/xrpl";
import { ExactXrplScheme } from "@x402/xrpl/exact/server";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  declareEip2612GasSponsoringExtension,
  declareErc20ApprovalGasSponsoringExtension,
} from "@x402/extensions";
import dotenv from "dotenv";
import { privateKeyToAccount } from "viem/accounts";

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
const HEDERA_NETWORK = (process.env.HEDERA_NETWORK || "hedera:testnet") as `${string}:${string}`;
const AVM_NETWORK = (process.env.AVM_NETWORK ||
  "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe") as `${string}:${string}`;
const KEETA_NETWORK = (process.env.KEETA_NETWORK || KEETA_TESTNET_CAIP2) as `${string}:${string}`;
const STELLAR_NETWORK = (process.env.STELLAR_NETWORK || "stellar:testnet") as `${string}:${string}`;
const TVM_NETWORK = (process.env.TVM_NETWORK || "tvm:-3") as `${string}:${string}`;
const CCD_NETWORK = (process.env.CCD_NETWORK ||
  "ccd:4221332d34e1694168c2a0c0b3fd0f27") as `${string}:${string}`;
const CCD_PAYEE_ADDRESS = process.env.CCD_PAYEE_ADDRESS as string | undefined;
const CCD_WEATHER_PRICE_MICRO_CCD = "1000";
const EVM_PAYEE_ADDRESS = process.env.EVM_PAYEE_ADDRESS as `0x${string}`;
const SVM_PAYEE_ADDRESS = process.env.SVM_PAYEE_ADDRESS as string;
const EVM_PERMIT2_ASSET = process.env.EVM_PERMIT2_ASSET as `0x${string}`;
const AVM_PAYEE_ADDRESS = process.env.AVM_PAYEE_ADDRESS as string;
const APTOS_PAYEE_ADDRESS = process.env.APTOS_PAYEE_ADDRESS as string;
const HEDERA_PAYEE_ADDRESS = process.env.HEDERA_PAYEE_ADDRESS as string | undefined;
const KEETA_PAYEE_ADDRESS = process.env.KEETA_PAYEE_ADDRESS as string | undefined;
const STELLAR_PAYEE_ADDRESS = process.env.STELLAR_PAYEE_ADDRESS as string | undefined;
const TVM_PAYEE_ADDRESS = process.env.TVM_PAYEE_ADDRESS as string | undefined;
const NEAR_NETWORK = (process.env.NEAR_NETWORK || "near:testnet") as `${string}:${string}`;
const NEAR_PAYEE_ADDRESS = process.env.NEAR_PAYEE_ADDRESS as string | undefined;
const NEAR_ASSET = process.env.NEAR_ASSET as string | undefined;
const NEAR_AMOUNT = process.env.NEAR_AMOUNT as string | undefined;
const XRPL_NETWORK = (process.env.XRPL_NETWORK || "xrpl:1") as `${string}:${string}`;
const XRPL_PAYEE_ADDRESS = process.env.XRPL_PAYEE_ADDRESS as string | undefined;
const XRPL_ASSET = process.env.XRPL_ASSET as string | undefined;
const XRPL_AMOUNT = process.env.XRPL_AMOUNT as string | undefined;
const XRPL_ISSUER = process.env.XRPL_ISSUER as string | undefined;
const HEDERA_ASSET = process.env.HEDERA_ASSET ?? "0.0.0"; // 0.0.0 = HBAR or 0.0.429274 for USDC testnet
const HEDERA_AMOUNT = process.env.HEDERA_AMOUNT ?? "100000"; // price in smallest units (tinybars or token decimals), defaults to 0.001 HBAR or 0.1 USDC
const facilitatorUrl = process.env.FACILITATOR_URL;

const xrplPaymentConfig = (payTo: string, assetTransferMethod: XrplAssetTransferMethod) => ({
  accepts: {
    payTo,
    scheme: "exact" as const,
    price: {
      amount: XRPL_AMOUNT || "1000",
      asset: XRPL_ASSET || "XRP",
      extra: {
        assetTransferMethod,
        ...(XRPL_ASSET && XRPL_ASSET !== "XRP" && XRPL_ISSUER ? { issuer: XRPL_ISSUER } : {}),
      },
    },
    network: XRPL_NETWORK,
  },
  extensions: {
    ...declareDiscoveryExtension({
      output: {
        example: {
          message: "Protected XRPL endpoint accessed successfully",
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
});

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
if (AVM_PAYEE_ADDRESS) {
  server.register("algorand:*", new ExactAvmScheme());
}
if (CCD_PAYEE_ADDRESS) {
  server.register("ccd:*", new ExactConcordiumScheme());
}
server.register("eip155:*", new ExactEvmScheme());
server.register("eip155:*", new UptoEvmScheme());

// Register batch-settlement scheme for the EVM payee.
// e2e flow does NOT use ChannelManager — settle actions are handled inline.
const receiverAuthorizerPrivateKey = process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY as
  | `0x${string}`
  | undefined;
const receiverAuthorizerSigner = receiverAuthorizerPrivateKey
  ? privateKeyToAccount(receiverAuthorizerPrivateKey)
  : undefined;
server.register(
  "eip155:*",
  new BatchSettlementEvmScheme(EVM_PAYEE_ADDRESS, {
    ...(receiverAuthorizerSigner ? { receiverAuthorizerSigner } : {}),
  }),
);
server.register("solana:*", new ExactSvmScheme());
if (APTOS_PAYEE_ADDRESS) {
  server.register("aptos:*", new ExactAptosScheme());
}
if (HEDERA_PAYEE_ADDRESS) {
  server.register("hedera:*", new ExactHederaScheme());
}
if (KEETA_PAYEE_ADDRESS) {
  server.register("keeta:*", new ExactKeetaScheme());
}
if (STELLAR_PAYEE_ADDRESS) {
  server.register("stellar:*", new ExactStellarScheme());
}
if (TVM_PAYEE_ADDRESS) {
  server.register("tvm:*", new ExactTvmScheme());
}
if (NEAR_PAYEE_ADDRESS) {
  server.register("near:*", new ExactNearScheme());
}
if (XRPL_PAYEE_ADDRESS) {
  server.register("xrpl:*", new ExactXrplScheme());
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
  if (path === "/exact/avm" && !AVM_PAYEE_ADDRESS) {
    return reply.status(501).send({
      error: "AVM payments not configured",
      message: "AVM_PAYEE_ADDRESS environment variable is not set",
    });
  }
  if (path === "/exact/aptos" && !APTOS_PAYEE_ADDRESS) {
    return reply.status(501).send({
      error: "Aptos payments not configured",
      message: "APTOS_PAYEE_ADDRESS environment variable is not set",
    });
  }
  if (path === "/exact/hedera" && !HEDERA_PAYEE_ADDRESS) {
    return reply.status(501).send({
      error: "Hedera payments not configured",
      message: "HEDERA_PAYEE_ADDRESS environment variable is not set",
    });
  }
  if (path === "/exact/keeta" && !KEETA_PAYEE_ADDRESS) {
    return reply.status(501).send({
      error: "Keeta payments not configured",
      message: "KEETA_PAYEE_ADDRESS environment variable is not set",
    });
  }
  if (path === "/exact/ccd" && !CCD_PAYEE_ADDRESS) {
    return reply.status(501).send({
      error: "Concordium payments not configured",
      message: "CCD_PAYEE_ADDRESS environment variable is not set",
    });
  }
  if (path.startsWith("/exact/stellar") && !STELLAR_PAYEE_ADDRESS) {
    return reply.status(501).send({
      error: "Stellar payments not configured",
      message: "STELLAR_PAYEE_ADDRESS environment variable is not set",
    });
  }
  if (path.startsWith("/exact/tvm") && !TVM_PAYEE_ADDRESS) {
    return reply.status(501).send({
      error: "TVM payments not configured",
      message: "TVM_PAYEE_ADDRESS environment variable is not set",
    });
  }
  if (path.startsWith("/exact/near") && !NEAR_PAYEE_ADDRESS) {
    return reply.status(501).send({
      error: "NEAR payments not configured",
      message: "NEAR_PAYEE_ADDRESS environment variable is not set",
    });
  }
  if (path.startsWith("/exact/xrpl") && !XRPL_PAYEE_ADDRESS) {
    return reply.status(501).send({
      error: "XRPL payments not configured",
      message: "XRPL_PAYEE_ADDRESS environment variable is not set",
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
    ...(AVM_PAYEE_ADDRESS
      ? {
          "GET /exact/avm": {
            accepts: {
              payTo: AVM_PAYEE_ADDRESS,
              scheme: "exact",
              price: "$0.001",
              network: AVM_NETWORK,
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
    ...(CCD_PAYEE_ADDRESS
      ? {
          "GET /exact/ccd": {
            accepts: {
              payTo: CCD_PAYEE_ADDRESS,
              scheme: "exact",
              price: {
                amount: CCD_WEATHER_PRICE_MICRO_CCD,
                asset: "CCD",
              },
              network: CCD_NETWORK,
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
    "GET /batch-settlement/evm/eip3009": {
      accepts: {
        payTo: EVM_PAYEE_ADDRESS,
        scheme: "batch-settlement",
        price: "$0.001",
        network: EVM_NETWORK,
      },
    },
    "GET /batch-settlement/evm/permit2": {
      accepts: {
        payTo: EVM_PAYEE_ADDRESS,
        scheme: "batch-settlement",
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
    },
    "GET /batch-settlement/evm/permit2-eip2612GasSponsoring": {
      accepts: {
        payTo: EVM_PAYEE_ADDRESS,
        scheme: "batch-settlement",
        network: EVM_NETWORK,
        price: "$0.001",
        extra: { assetTransferMethod: "permit2" },
      },
      extensions: {
        ...declareEip2612GasSponsoringExtension(),
      },
    },
    "GET /batch-settlement/evm/permit2-erc20ApprovalGasSponsoring": {
      accepts: {
        payTo: EVM_PAYEE_ADDRESS,
        scheme: "batch-settlement",
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
    ...(HEDERA_PAYEE_ADDRESS
      ? {
          "GET /exact/hedera": {
            accepts: {
              payTo: HEDERA_PAYEE_ADDRESS,
              scheme: "exact" as const,
              price: {
                amount: HEDERA_AMOUNT,
                asset: HEDERA_ASSET,
              },
              network: HEDERA_NETWORK,
            },
            extensions: {
              ...declareDiscoveryExtension({
                output: {
                  example: {
                    message: "Protected Hedera endpoint accessed successfully",
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
    ...(KEETA_PAYEE_ADDRESS
      ? {
          "GET /exact/keeta": {
            accepts: {
              payTo: KEETA_PAYEE_ADDRESS,
              scheme: "exact",
              price: "$0.001",
              network: KEETA_NETWORK,
            },
            extensions: {
              ...declareDiscoveryExtension({
                output: {
                  example: {
                    message: "Protected Keeta endpoint accessed successfully",
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
    ...(TVM_PAYEE_ADDRESS
      ? {
          "GET /exact/tvm": {
            accepts: {
              payTo: TVM_PAYEE_ADDRESS,
              scheme: "exact",
              price: "$0.001",
              network: TVM_NETWORK,
            },
            extensions: {
              ...declareDiscoveryExtension({
                output: {
                  example: {
                    message: "Protected TVM endpoint accessed successfully",
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
    ...(NEAR_PAYEE_ADDRESS
      ? {
          "GET /exact/near": {
            accepts: {
              payTo: NEAR_PAYEE_ADDRESS,
              scheme: "exact" as const,
              price: {
                amount: NEAR_AMOUNT || "1000000000000000000000",
                asset: NEAR_ASSET || "wrap.testnet",
              },
              network: NEAR_NETWORK,
            },
            extensions: {
              ...declareDiscoveryExtension({
                output: {
                  example: {
                    message: "Protected NEAR endpoint accessed successfully",
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
    ...(XRPL_PAYEE_ADDRESS
      ? {
          "GET /exact/xrpl/sequence": xrplPaymentConfig(XRPL_PAYEE_ADDRESS, "sequence"),
          "GET /exact/xrpl/ticketSequence": xrplPaymentConfig(XRPL_PAYEE_ADDRESS, "ticketSequence"),
        }
      : {}),
  },
  server, // Pass pre-configured server instance
);

/**
 * Protected batch-settlement endpoint — exercised by repeated voucher requests
 * over a single payment channel followed by an optional cooperative refund.
 */
app.get("/batch-settlement/evm/eip3009", async () => {
  return {
    message: "Batch-settlement endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  };
});

app.get("/batch-settlement/evm/permit2", async () => {
  return {
    message: "Batch-settlement Permit2 endpoint accessed successfully",
    timestamp: new Date().toISOString(),
    method: "batch-settlement-permit2",
  };
});

app.get("/batch-settlement/evm/permit2-eip2612GasSponsoring", async () => {
  return {
    message: "Batch-settlement Permit2 EIP-2612 endpoint accessed successfully",
    timestamp: new Date().toISOString(),
    method: "batch-settlement-permit2-eip2612",
  };
});

app.get("/batch-settlement/evm/permit2-erc20ApprovalGasSponsoring", async () => {
  return {
    message: "Batch-settlement Permit2 ERC-20 approval endpoint accessed successfully",
    timestamp: new Date().toISOString(),
    method: "batch-settlement-permit2-erc20-approval",
  };
});

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
 * Protected AVM endpoint - requires payment to access
 *
 * This endpoint demonstrates a resource protected by x402 payment middleware for AVM.
 * Clients must provide a valid payment signature to access this endpoint.
 * Note: 501 check is handled by pre-middleware guard above.
 */
app.get("/exact/avm", async () => {
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
if (HEDERA_PAYEE_ADDRESS) {
  app.get("/exact/hedera", async () => {
    return {
      message: "Protected Hedera endpoint accessed successfully",
      timestamp: new Date().toISOString(),
    };
  });
}

if (KEETA_PAYEE_ADDRESS) {
  app.get("/exact/keeta", async () => {
    return {
      message: "Protected Keeta endpoint accessed successfully",
      timestamp: new Date().toISOString(),
    };
  });
}

if (CCD_PAYEE_ADDRESS) {
  app.get("/exact/ccd", async () => {
    return {
      message: "Protected Concordium endpoint accessed successfully",
      timestamp: new Date().toISOString(),
    };
  });
}

if (STELLAR_PAYEE_ADDRESS) {
  app.get("/exact/stellar", async () => {
    return {
      message: "Protected Stellar endpoint accessed successfully",
      timestamp: new Date().toISOString(),
    };
  });
}

if (TVM_PAYEE_ADDRESS) {
  app.get("/exact/tvm", async () => {
    return {
      message: "Protected TVM endpoint accessed successfully",
      timestamp: new Date().toISOString(),
    };
  });
}

if (NEAR_PAYEE_ADDRESS) {
  app.get("/exact/near", async () => {
    return {
      message: "Protected NEAR endpoint accessed successfully",
      timestamp: new Date().toISOString(),
    };
  });
}

if (XRPL_PAYEE_ADDRESS) {
  for (const assetTransferMethod of ["sequence", "ticketSequence"] as const) {
    app.get(`/exact/xrpl/${assetTransferMethod}`, async () => {
      return {
        message: "Protected XRPL endpoint accessed successfully",
        timestamp: new Date().toISOString(),
      };
    });
  }
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
║  AVM Network:  ${AVM_NETWORK}                          ║
║  EVM Network:  ${EVM_NETWORK}                          ║
║  SVM Network:  ${SVM_NETWORK}                          ║
║  Aptos Network: ${APTOS_NETWORK}                       ║
║  Hedera Network: ${HEDERA_NETWORK}                     ║
║  Keeta Network:  ${KEETA_NETWORK}                      ║
║  Stellar Network: ${STELLAR_NETWORK}║
║  TVM Network: ${TVM_NETWORK}║
║  NEAR Network: ${NEAR_NETWORK}║
║  XRPL Network: ${XRPL_NETWORK}║
║  CCD Network:  ${CCD_NETWORK}                          ║
║  AVM Payee:    ${AVM_PAYEE_ADDRESS || "(not configured)"}
║  EVM Payee:    ${EVM_PAYEE_ADDRESS}                    ║
║  SVM Payee:    ${SVM_PAYEE_ADDRESS}                    ║
║  Aptos Payee:  ${APTOS_PAYEE_ADDRESS || "(not configured)"}
║  Hedera Payee: ${HEDERA_PAYEE_ADDRESS || "(not configured)"}
║  Keeta Payee:   ${KEETA_PAYEE_ADDRESS || "(not configured)"}
║  CCD Payee:    ${CCD_PAYEE_ADDRESS || "(not configured)"}
║  Stellar Payee: ${STELLAR_PAYEE_ADDRESS || "(not configured)"}
║  TVM Payee: ${TVM_PAYEE_ADDRESS || "(not configured)"}
║  NEAR Payee: ${NEAR_PAYEE_ADDRESS || "(not configured)"}
║  XRPL Payee: ${XRPL_PAYEE_ADDRESS || "(not configured)"}
║                                                        ║
║  Endpoints:                                            ║
║  • GET  /exact/avm                            (AVM)           ║
║  • GET  /exact/evm/eip3009                    (EVM EIP-3009)  ║
║  • GET  /exact/evm/permit2                    (Permit2)       ║
║  • GET  /exact/evm/permit2-eip2612GasSponsoring               ║
║  • GET  /exact/evm/permit2-erc20ApprovalGasSponsoring         ║
║  • GET  /exact/svm                            (SVM)           ║
║  • GET  /exact/aptos                          (Aptos)         ║
║  • GET  /exact/hedera                         (Hedera)        ║
║  • GET  /exact/keeta                          (Keeta)         ║
║  • GET  /exact/ccd                            (CCD)           ║
║  • GET  /exact/stellar                        (Stellar)       ║
║  • GET  /exact/tvm                            (TVM)           ║
║  • GET  /exact/near                           (NEAR)          ║
║  • GET  /exact/xrpl/sequence                  (XRPL Sequence) ║
║  • GET  /exact/xrpl/ticketSequence            (XRPL Ticket)   ║
║  • GET  /health                (no payment required)       ║
║  • POST /close                 (shutdown server)           ║
╚════════════════════════════════════════════════════════╝
  `);
});
