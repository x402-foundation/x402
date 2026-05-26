import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { type AuthorizerSigner, toFacilitatorEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, nonceManager, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

dotenv.config();

// Configuration
const PORT = process.env.PORT || "4022";

// Validate required environment variables
if (!process.env.EVM_PRIVATE_KEY) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

const evmRpcUrl = process.env.EVM_RPC_URL ?? "https://sepolia.base.org";

// Treat unset or blank like Go's envOr: `.env` often has `KEY=` which is "" not undefined.
const receiverAuthorizerPrivateKey =
  process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY?.trim() ||
  process.env.EVM_PRIVATE_KEY;

// Initialize the EVM account from private key (submits transactions)
const evmAccount = privateKeyToAccount(
  process.env.EVM_PRIVATE_KEY as `0x${string}`,
  { nonceManager },
);

// Dedicated receiverAuthorizer (signs ClaimBatch / Refund EIP-712 messages)
const authorizerAccount = privateKeyToAccount(
  receiverAuthorizerPrivateKey as `0x${string}`,
);
const authorizerSigner: AuthorizerSigner = {
  address: authorizerAccount.address,
  signTypedData: (params) =>
    authorizerAccount.signTypedData(
      params as Parameters<typeof authorizerAccount.signTypedData>[0],
    ),
};

console.info(`EVM Facilitator account: ${evmAccount.address}`);
console.info(`EVM Receiver Authorizer: ${authorizerSigner.address}`);

// Create a Viem client with both wallet and public capabilities
const viemClient = createWalletClient({
  account: evmAccount,
  chain: baseSepolia,
  transport: http(evmRpcUrl),
}).extend(publicActions);

// Initialize the x402 Facilitator with EVM support
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

// Register EVM schemes (batched: deposit / voucher / claim / settle)
facilitator.register(
  "eip155:84532",
  new BatchSettlementEvmScheme(evmSigner, authorizerSigner),
); // Base Sepolia

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

// Start the server
app.listen(parseInt(PORT), () => {
  console.log(`🚀 Facilitator listening on http://localhost:${PORT}`);
  console.log();
});
