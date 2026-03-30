import { paymentProxy } from "@x402/next";
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

export const EVM_PAYEE_ADDRESS = process.env.EVM_PAYEE_ADDRESS as `0x${string}`;
export const SVM_PAYEE_ADDRESS = process.env.SVM_PAYEE_ADDRESS as string;
export const APTOS_PAYEE_ADDRESS = process.env.APTOS_PAYEE_ADDRESS as string;
export const STELLAR_PAYEE_ADDRESS = process.env.STELLAR_PAYEE_ADDRESS as string | undefined;
export const EVM_NETWORK = (process.env.EVM_NETWORK || "eip155:84532") as `${string}:${string}`;
export const SVM_NETWORK = (process.env.SVM_NETWORK ||
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1") as `${string}:${string}`;
export const APTOS_NETWORK = (process.env.APTOS_NETWORK || "aptos:2") as `${string}:${string}`;
export const STELLAR_NETWORK = (process.env.STELLAR_NETWORK ||
  "stellar:testnet") as `${string}:${string}`;
const EVM_PERMIT2_ASSET = process.env.EVM_PERMIT2_ASSET as `0x${string}`;
const facilitatorUrl = process.env.FACILITATOR_URL;

if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}

// Create facilitator clients (mock facilitator as fallback for startup validation)
const facilitatorClients = [new HTTPFacilitatorClient({ url: facilitatorUrl })];
const mockFacilitatorUrl = process.env.MOCK_FACILITATOR_URL;
if (mockFacilitatorUrl) {
  facilitatorClients.push(new HTTPFacilitatorClient({ url: mockFacilitatorUrl }));
}

// Create x402 resource server with builder pattern (cleaner!)
export const server = new x402ResourceServer(facilitatorClients);

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

console.log(`Using remote facilitator at: ${facilitatorUrl}`);

export const proxy = paymentProxy(
  {
    "/api/exact/evm/eip3009/proxy": {
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
    "/api/exact/svm": {
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
          "/api/exact/aptos": {
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
    ...(STELLAR_PAYEE_ADDRESS
      ? {
          "/api/exact/stellar": {
            accepts: {
              payTo: STELLAR_PAYEE_ADDRESS,
              scheme: "exact",
              price: "$0.001",
              network: STELLAR_NETWORK,
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
    "/api/exact/evm/permit2/proxy": {
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
    "/api/exact/evm/permit2-eip2612GasSponsoring/proxy": {
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
    "/api/exact/evm/permit2-erc20ApprovalGasSponsoring/proxy": {
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
    "/api/upto/evm/permit2": {
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
    "/api/upto/evm/permit2-eip2612GasSponsoring": {
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
    "/api/upto/evm/permit2-erc20ApprovalGasSponsoring": {
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
  },
  server, // Pass pre-configured server instance
);

export const config = {
  matcher: [
    "/api/exact/evm/eip3009/proxy",
    "/api/exact/svm",
    "/api/exact/aptos",
    "/api/exact/stellar",
    "/api/exact/evm/permit2/proxy",
    "/api/exact/evm/permit2-eip2612GasSponsoring/proxy",
    "/api/exact/evm/permit2-erc20ApprovalGasSponsoring/proxy",
    "/api/upto/evm/permit2",
    "/api/upto/evm/permit2-eip2612GasSponsoring",
    "/api/upto/evm/permit2-erc20ApprovalGasSponsoring",
  ],
};
