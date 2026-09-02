/**
 * Batch-settlement facilitator example (EVM + SVM)
 *
 * Registers the `batch-settlement` scheme on Base Sepolia and/or Solana Devnet.
 * For SVM, wires {@link BatchSvmRentCleanupManager} to the scheme's channel
 * storage so abandoned channels are sealed and rent is reclaimed asynchronously.
 */

import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import type { Network } from "@x402/core/types";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { type AuthorizerSigner, toFacilitatorEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import {
  BatchSvmRentCleanupManager,
  BatchSvmScheme,
  InMemoryBatchChannelStorage,
  type RentCleanupCloseResult,
  type RentCleanupReclaimResult,
} from "@x402/svm/batch-settlement/facilitator";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, nonceManager, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

dotenv.config();

// Configuration
const PORT = process.env.PORT || "4022";
const EVM_NETWORK = "eip155:84532" as Network;
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network;

const evmPrivateKey = process.env.EVM_PRIVATE_KEY?.trim();
const svmPrivateKey = process.env.SVM_PRIVATE_KEY?.trim();
const evmRpcUrl = process.env.EVM_RPC_URL ?? "https://sepolia.base.org";
const svmRpcUrl = process.env.SVM_RPC_URL;

// Validate required environment variables
if (!evmPrivateKey && !svmPrivateKey) {
  console.error(
    "❌ At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required",
  );
  process.exit(1);
}

// Treat unset or blank as not configured
const receiverAuthorizerPrivateKey =
  process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY?.trim();

const rentCleanupIntervalSecs = Number.parseInt(
  process.env.RENT_CLEANUP_INTERVAL_SECS ?? "30",
  10,
);
const abandonGraceSecs = Number.parseInt(
  process.env.RENT_CLEANUP_ABANDON_GRACE_SECS ?? "120",
  10,
);

const channelStorage = new InMemoryBatchChannelStorage();
const facilitator = new x402Facilitator()
  .onBeforeVerify(async (context) => {
    console.log("Before verify", context);
  })
  .onAfterVerify(async (context) => {
    console.log("After verify", context);
  })
  .onVerifyFailure(async (context) => {
    console.log("Verify failure", context);
  })
  .onBeforeSettle(async (context) => {
    console.log("Before settle", context);
  })
  .onAfterSettle(async (context) => {
    console.log("After settle", context);
  })
  .onSettleFailure(async (context) => {
    console.log("Settle failure", context);
  });

let rentCleanupManager: BatchSvmRentCleanupManager | undefined;

if (evmPrivateKey) {
  // Initialize the EVM account from private key (submits transactions)
  const evmAccount = privateKeyToAccount(evmPrivateKey as `0x${string}`, {
    nonceManager,
  });

  // Optional receiverAuthorizer (signs ClaimBatch / Refund EIP-712 messages)
  let authorizerSigner: AuthorizerSigner | undefined;
  if (receiverAuthorizerPrivateKey) {
    const authorizerAccount = privateKeyToAccount(
      receiverAuthorizerPrivateKey as `0x${string}`,
    );
    authorizerSigner = {
      address: authorizerAccount.address,
      signTypedData: (params) =>
        authorizerAccount.signTypedData(
          params as Parameters<typeof authorizerAccount.signTypedData>[0],
        ),
    };
  }

  console.info(`EVM Facilitator account: ${evmAccount.address}`);
  if (authorizerSigner) {
    console.info(`EVM Receiver Authorizer: ${authorizerSigner.address}`);
  } else {
    console.info("EVM Receiver Authorizer: not configured");
  }

  // Create a Viem client with both wallet and public capabilities
  const viemClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http(evmRpcUrl),
  }).extend(publicActions);

  const evmSigner = toFacilitatorEvmSigner({
    address: evmAccount.address,
    getCode: (args) => viemClient.getCode(args),
    readContract: (args) =>
      viemClient.readContract({ ...args, args: args.args ?? [] } as Parameters<
        typeof viemClient.readContract
      >[0]),
    verifyTypedData: (args) =>
      viemClient.verifyTypedData(
        args as Parameters<typeof viemClient.verifyTypedData>[0],
      ),
    writeContract: (args) =>
      viemClient.writeContract(
        args as Parameters<typeof viemClient.writeContract>[0],
      ),
    sendTransaction: (args) =>
      viemClient.sendTransaction(
        args as Parameters<typeof viemClient.sendTransaction>[0],
      ),
    waitForTransactionReceipt: (args) =>
      viemClient.waitForTransactionReceipt(args),
  });

  // Register EVM scheme (batched: deposit / voucher / claim / settle)
  facilitator.register(
    EVM_NETWORK,
    new BatchSettlementEvmScheme(evmSigner, authorizerSigner),
  ); // Base Sepolia
}

if (svmPrivateKey) {
  const svmAccount = await createKeyPairSignerFromBytes(
    base58.decode(svmPrivateKey),
  );
  console.info(`SVM Facilitator account: ${svmAccount.address}`);

  const svmSigner = toFacilitatorSvmSigner(
    svmAccount,
    svmRpcUrl ? { defaultRpcUrl: svmRpcUrl } : undefined,
  );
  const svmBatchScheme = new BatchSvmScheme(svmSigner, { channelStorage });
  facilitator.register(SVM_NETWORK, svmBatchScheme);

  rentCleanupManager = svmBatchScheme.createRentCleanupManager(SVM_NETWORK);
  rentCleanupManager.start({
    intervalSecs: rentCleanupIntervalSecs,
    abandonGraceSecs,
    onClose: (result: RentCleanupCloseResult) => {
      console.info(
        `[rent-cleanup] ${result.action} channel=${result.channelId} tx=${result.transaction}`,
      );
    },
    onReclaim: (result: RentCleanupReclaimResult) => {
      console.info(
        `[rent-cleanup] reclaim channels=${result.channelIds.join(",")} tx=${result.transaction}`,
      );
    },
    onError: (error: unknown, context?: { channelId?: string }) => {
      console.error("[rent-cleanup] error", {
        channelId: context?.channelId,
        error: error instanceof Error ? error.message : error,
      });
    },
  });
  console.info(
    `SVM rent cleanup started (interval=${rentCleanupIntervalSecs}s, abandonGrace=${abandonGraceSecs}s)`,
  );
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
 * Settle a payment onchain
 *
 * Note: Verification validation and cleanup are handled by lifecycle hooks
 */
app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    // Hooks will automatically:
    // - Validate payment was verified (onBeforeSettle - will abort if not)
    // - Check verification timeout (onBeforeSettle)
    // - Clean up tracking (onAfterSettle / onSettleFailure)
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
      // Return a proper SettleResponse instead of 500 error
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
app.get("/supported", async (_req, res) => {
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

const enabledNetworks = [
  evmPrivateKey ? "EVM (Base Sepolia)" : null,
  svmPrivateKey ? "Solana (devnet)" : null,
]
  .filter(Boolean)
  .join(", ");

// Start the server
app.listen(parseInt(PORT), () => {
  console.log(
    `🚀 Batch-settlement facilitator listening on http://localhost:${PORT}`,
  );
  console.log(`   Networks: ${enabledNetworks}`);
  console.log();
});

async function shutdown(): Promise<void> {
  await rentCleanupManager?.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
