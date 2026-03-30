/**
 * Facilitator with Discovery Extension Example
 *
 * Demonstrates how to create a facilitator with bazaar discovery extension that
 * catalogs discovered x402 resources.
 */

import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import { extractDiscoveryInfo, DiscoveryInfo } from "@x402/extensions/bazaar";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

dotenv.config();

// Configuration
const PORT = process.env.PORT || "4022";

// Configuration - optional per network
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string | undefined;

// Validate at least one private key is provided
if (!evmPrivateKey && !svmPrivateKey) {
  console.error(
    "❌ At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required",
  );
  process.exit(1);
}

// Network configuration
const EVM_NETWORK = "eip155:84532"; // Base Sepolia
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // Solana Devnet

// DiscoveredResource represents a discovered x402 resource for the bazaar catalog
interface DiscoveredResource {
  resource: string;
  description?: string;
  mimeType?: string;
  type: string;
  x402Version: number;
  accepts: PaymentRequirements[];
  discoveryInfo?: DiscoveryInfo;
  lastUpdated: string;
}

// BazaarCatalog stores discovered resources
/**
 * Catalog of discovered resources from bazaar discovery extension.
 */
class BazaarCatalog {
  private resources: Map<string, DiscoveredResource> = new Map();

  /**
   * Adds a discovered resource to the catalog.
   *
   * @param res - The discovered resource to add
   */
  add(res: DiscoveredResource): void {
    this.resources.set(res.resource, res);
  }

  /**
   * Returns all discovered resources in the catalog.
   *
   * @returns Array of all discovered resources
   */
  getAll(): DiscoveredResource[] {
    return Array.from(this.resources.values());
  }
}

const bazaarCatalog = new BazaarCatalog();

// Initialize the x402 Facilitator with discovery hooks
const facilitator = new x402Facilitator()
  .onBeforeVerify(async (context) => {
    console.log("Before verify", context);
  })
  .onAfterVerify(async (context) => {
    console.log("✅ Payment verified");

    // Extract discovered resource from payment for bazaar catalog
    try {
      const discovered = extractDiscoveryInfo(
        context.paymentPayload,
        context.requirements,
        true, // validate
      );

      if (discovered) {
        console.log(`   📝 Discovered resource: ${discovered.resourceUrl}`);
        console.log(`   📝 Description: ${discovered.description}`);
        console.log(`   📝 MimeType: ${discovered.mimeType}`);
        if ("method" in discovered && discovered.method !== undefined) {
          console.log(`   📝 Method: ${discovered.method}`);
        } else if ("toolName" in discovered) {
          console.log(`   📝 Tool: ${discovered.toolName}`);
        }
        console.log(`   📝 X402Version: ${discovered.x402Version}`);

        bazaarCatalog.add({
          resource: discovered.resourceUrl,
          description: discovered.description,
          mimeType: discovered.mimeType,
          type: "http",
          x402Version: discovered.x402Version,
          accepts: [context.requirements],
          discoveryInfo: discovered.discoveryInfo,
          lastUpdated: new Date().toISOString(),
        });
        console.log("   ✅ Added to bazaar catalog");
      }
    } catch (err) {
      console.log(`   ⚠️  Failed to extract discovery info: ${err}`);
    }
  })
  .onVerifyFailure(async (context) => {
    console.log("Verify failure", context);
  })
  .onBeforeSettle(async (context) => {
    console.log("Before settle", context);
  })
  .onAfterSettle(async (context) => {
    console.log(`🎉 Payment settled: ${context.result.transaction}`);
  })
  .onSettleFailure(async (context) => {
    console.log("Settle failure", context);
  });

// Register EVM scheme if private key is provided
if (evmPrivateKey) {
  const evmAccount = privateKeyToAccount(evmPrivateKey);
  console.info(`EVM Facilitator account: ${evmAccount.address}`);

  // Create a Viem client with both wallet and public capabilities
  const viemClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http(),
  }).extend(publicActions);

  const evmSigner = toFacilitatorEvmSigner({
    getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
    address: evmAccount.address,
    readContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }) =>
      viemClient.readContract({
        ...args,
        args: args.args || [],
      }),
    verifyTypedData: (args: {
      address: `0x${string}`;
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
      signature: `0x${string}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => viemClient.verifyTypedData(args as any),
    writeContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args: readonly unknown[];
    }) =>
      viemClient.writeContract({
        ...args,
        args: args.args || [],
      }),
    sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
      viemClient.sendTransaction(args),
    waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
      viemClient.waitForTransactionReceipt(args),
  });

  facilitator.register(
    EVM_NETWORK,
    new ExactEvmScheme(evmSigner, { deployERC4337WithEIP6492: true }),
  );
}

// Register SVM scheme if private key is provided
if (svmPrivateKey) {
  const svmAccount = await createKeyPairSignerFromBytes(
    base58.decode(svmPrivateKey),
  );
  console.info(`SVM Facilitator account: ${svmAccount.address}`);

  const svmSigner = toFacilitatorSvmSigner(svmAccount);

  facilitator.register(SVM_NETWORK, new ExactSvmScheme(svmSigner));
}

// Initialize Express app
const app = express();
app.use(express.json());

/**
 * POST /verify
 * Verify a payment against requirements
 *
 * Note: Payment tracking and bazaar discovery are handled by lifecycle hooks
 */
app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    // Hooks will automatically:
    // - Track verified payment (onAfterVerify)
    // - Extract and catalog discovery info (onAfterVerify)
    const response: VerifyResponse = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /settle
 * Settle a payment on-chain
 */
app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);

    // Check if this was an abort from hook
    if (
      error instanceof Error &&
      error.message.includes("Settlement aborted:")
    ) {
      return res.json({
        success: false,
        errorReason: error.message.replace("Settlement aborted: ", ""),
        network: req.body?.paymentPayload?.network || "unknown",
      } as SettleResponse);
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /supported
 * Get supported payment kinds and extensions
 */
app.get("/supported", async (req, res) => {
  try {
    const response = facilitator.getSupported();
    res.json(response);
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /discovery/resources
 * List all discovered resources from bazaar
 */
app.get("/discovery/resources", async (req, res) => {
  try {
    const resources = bazaarCatalog.getAll();
    res.json({
      x402Version: 2,
      items: resources,
      pagination: {
        limit: 100,
        offset: 0,
        total: resources.length,
      },
    });
  } catch (error) {
    console.error("Discovery error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Start the server
app.listen(parseInt(PORT), () => {
  console.log(`🚀 Discovery Facilitator listening on http://localhost:${PORT}`);
  console.log(
    `   Supported networks: ${facilitator
      .getSupported()
      .kinds.map((k) => k.network)
      .join(", ")}`,
  );
  console.log(`   Discovery endpoint: GET /discovery/resources`);
  console.log();
});
