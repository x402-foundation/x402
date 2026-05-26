import { config } from "dotenv";
import { runHooksExample } from "./hooks";
import { runPreferredNetworkExample } from "./preferred-network";
import { runBuilderPatternExample } from "./builder-pattern";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;

/**
 * Main example runner for advanced x402 client patterns.
 *
 * This package demonstrates advanced patterns for production-ready x402 clients:
 *
 * - all-networks: All supported networks with optional chain configuration
 * - builder-pattern: Fine-grained control over network registration
 * - hooks: Payment lifecycle hooks for custom logic at different stages
 * - preferred-network: Client-side payment network preferences
 *
 * To run this example, you need to set the following environment variables:
 * - EVM_PRIVATE_KEY: The private key of the EVM signer
 * - SVM_PRIVATE_KEY: The private key of the SVM signer
 *
 * Usage:
 *   pnpm start all-networks
 *   pnpm start builder-pattern
 *   pnpm start hooks
 *   pnpm start preferred-network
 */
async function main(): Promise<void> {
  const pattern = process.argv[2] || "builder-pattern";

  console.log(`\n🚀 Running advanced example: ${pattern}\n`);

  if (!evmPrivateKey) {
    console.error("❌ EVM_PRIVATE_KEY environment variable is required");
    process.exit(1);
  }

  switch (pattern) {
    case "all-networks":
      await import("./all_networks.js");
      return;

    case "builder-pattern":
      if (!svmPrivateKey) {
        console.error("❌ SVM_PRIVATE_KEY environment variable is required for builder-pattern");
        process.exit(1);
      }
      await runBuilderPatternExample(evmPrivateKey, svmPrivateKey, url);
      break;

    case "hooks":
      await runHooksExample(evmPrivateKey, url);
      break;

    case "preferred-network":
      if (!svmPrivateKey) {
        console.error("❌ SVM_PRIVATE_KEY environment variable is required for preferred-network");
        process.exit(1);
      }
      await runPreferredNetworkExample(evmPrivateKey, svmPrivateKey, url);
      break;

    default:
      console.error(`Unknown pattern: ${pattern}`);
      console.error("Available patterns: all-networks, builder-pattern, hooks, preferred-network");
      process.exit(1);
  }
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
