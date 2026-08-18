/**
 * Upto facilitator example (EVM + SVM)
 *
 * Registers the `upto` scheme on Base Sepolia and/or Solana Devnet. For SVM,
 * wires {@link UptoSvmRentCleanupManager} to the scheme's channel storage so
 * abandoned channels are sealed and rent is reclaimed asynchronously.
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
import { toFacilitatorEvmSigner } from "@x402/evm";
import { UptoEvmScheme } from "@x402/evm/upto/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import {
  InMemoryUptoChannelStorage,
  UptoSvmRentCleanupManager,
  UptoSvmScheme,
} from "@x402/svm/upto/facilitator";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

dotenv.config();

const PORT = process.env.PORT || "4022";
const EVM_NETWORK = "eip155:84532" as Network;
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network;

const evmPrivateKey = process.env.EVM_PRIVATE_KEY?.trim();
const svmPrivateKey = process.env.SVM_PRIVATE_KEY?.trim();
const evmRpcUrl = process.env.EVM_RPC_URL;
const svmRpcUrl = process.env.SVM_RPC_URL;

if (!evmPrivateKey && !svmPrivateKey) {
  console.error(
    "❌ At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required",
  );
  process.exit(1);
}

const rentCleanupIntervalSecs = Number.parseInt(
  process.env.RENT_CLEANUP_INTERVAL_SECS ?? "30",
  10,
);
const abandonGraceSecs = Number.parseInt(
  process.env.RENT_CLEANUP_ABANDON_GRACE_SECS ?? "120",
  10,
);
const maxChannelLifetimeSecs = Number.parseInt(
  process.env.MAX_CHANNEL_LIFETIME_SECS ?? "3600",
  10,
);

const channelStorage = new InMemoryUptoChannelStorage();
const facilitator = new x402Facilitator()
  .onBeforeVerify(async (context) => {
    console.log("Before verify", context);
  })
  .onAfterVerify(async (context) => {
    console.log("After verify", context);
  })
  .onVerifyFailure(async (context) => {
    console.error("Verify failure", {
      error: context.error.message,
      paymentPayload: context.paymentPayload,
      requirements: context.requirements,
    });
  })
  .onBeforeSettle(async (context) => {
    console.log("Before settle", context);
  })
  .onAfterSettle(async (context) => {
    console.log("After settle", context);
  })
  .onSettleFailure(async (context) => {
    console.error("Settle failure", {
      error: context.error.message,
      paymentPayload: context.paymentPayload,
      requirements: context.requirements,
    });
  });
let rentCleanupManager: UptoSvmRentCleanupManager | undefined;

if (evmPrivateKey) {
  const evmAccount = privateKeyToAccount(evmPrivateKey as `0x${string}`);
  console.info(`EVM Facilitator account: ${evmAccount.address}`);

  const viemClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http(evmRpcUrl),
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

  facilitator.register(EVM_NETWORK, new UptoEvmScheme(evmSigner));
}

if (svmPrivateKey) {
  const svmAccount = await createKeyPairSignerFromBytes(
    base58.decode(svmPrivateKey),
  );
  console.info(`SVM Facilitator account: ${svmAccount.address}`);

  const svmSigner = toFacilitatorSvmSigner(svmAccount);
  const svmUptoScheme = new UptoSvmScheme(svmSigner, {
    channelStorage,
    maxChannelLifetimeSecs,
    rpcUrl: svmRpcUrl,
  });
  facilitator.register(SVM_NETWORK, svmUptoScheme);

  rentCleanupManager = svmUptoScheme.createRentCleanupManager(SVM_NETWORK);
  rentCleanupManager.start({
    intervalSecs: rentCleanupIntervalSecs,
    abandonGraceSecs,
    onClose: (result) => {
      console.info(
        `[rent-cleanup] ${result.action} channel=${result.channelId} tx=${result.transaction}`,
      );
    },
    onReclaim: (result) => {
      console.info(
        `[rent-cleanup] reclaim channels=${result.channelIds.join(",")} tx=${result.transaction}`,
      );
    },
    onError: (error, context) => {
      console.error("[rent-cleanup] error", {
        channelId: context?.channelId,
        error: error instanceof Error ? error.message : error,
      });
    },
  });
  console.info(
    `SVM rent cleanup started (interval=${rentCleanupIntervalSecs}s, abandonGrace=${abandonGraceSecs}s, maxChannelLifetime=${maxChannelLifetimeSecs}s)`,
  );
}

const app = express();
app.use(express.json());

/**
 * POST /verify
 * Verify a payment against requirements.
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
 * Settle a verified payment on-chain.
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
 * Return supported payment kinds and extensions.
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

app.listen(parseInt(PORT), () => {
  console.log(`🚀 Upto facilitator listening on http://localhost:${PORT}`);
  console.log(`   Networks: ${enabledNetworks}`);
  console.log();
});

/**
 * Stop rent cleanup and exit the process on SIGINT/SIGTERM.
 *
 * Awaits the in-flight pass so a settle that is already broadcast is not
 * abandoned before its storage entry is updated.
 */
async function shutdown(): Promise<void> {
  await rentCleanupManager?.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
