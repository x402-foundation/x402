import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import { FileChannelStorage } from "@x402/evm/batch-settlement/server/file-storage";
import {
  paymentMiddlewareFromHTTPServer,
  setSettlementOverrides,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/express";
import { BatchSvmScheme, MemoryChannelStore } from "@x402/svm/batch-settlement/server";
import { config } from "dotenv";
import express from "express";
import { privateKeyToAccount } from "viem/accounts";

config();

const EVM_NETWORK = "eip155:84532" as Network;
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network;

const evmAddress = process.env.EVM_ADDRESS?.trim() as `0x${string}` | undefined;
const svmAddress = process.env.SVM_ADDRESS?.trim();
const receiverAuthorizerPrivateKey = process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY?.trim() as
  | `0x${string}`
  | undefined;
const svmReceiverAuthorizerPrivateKey = process.env.SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY?.trim();
const storageDir = process.env.STORAGE_DIR;
const withdrawDelay = Number(process.env.DEFERRED_WITHDRAW_DELAY_SECONDS ?? "86400");

if ((!evmAddress || !/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) && !svmAddress) {
  console.error("Missing required EVM_ADDRESS or SVM_ADDRESS environment variable");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("Missing required FACILITATOR_URL environment variable");
  process.exit(1);
}

const receiverAuthorizerSigner = receiverAuthorizerPrivateKey
  ? privateKeyToAccount(receiverAuthorizerPrivateKey)
  : undefined;

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const app = express();

// Authorize up to this amount per request; optional usage-based override below bills actual usage (EVM only).
const maxPrice = "$0.01";

/**
 * Initializes facilitator capability checks and starts the batch-settlement server.
 */
async function main() {
  const svmReceiverAuthorizerSigner = svmReceiverAuthorizerPrivateKey
    ? await createKeyPairSignerFromBytes(base58.decode(svmReceiverAuthorizerPrivateKey))
    : undefined;

  let resourceServer = new x402ResourceServer(facilitatorClient);
  let channelManager: ReturnType<BatchSettlementEvmScheme["createChannelManager"]> | undefined;

  if (evmAddress) {
    const batchedEvmScheme = new BatchSettlementEvmScheme(evmAddress, {
      ...(receiverAuthorizerSigner ? { receiverAuthorizerSigner } : {}),
      withdrawDelay,
      ...(storageDir ? { storage: new FileChannelStorage({ directory: storageDir }) } : {}),
    });
    resourceServer = resourceServer.register(EVM_NETWORK, batchedEvmScheme);

    channelManager = batchedEvmScheme.createChannelManager(facilitatorClient, EVM_NETWORK);
    channelManager.start({
      claimIntervalSecs: 60,
      settleIntervalSecs: 120,
      refundIntervalSecs: 180,
      maxClaimsPerBatch: 100,
      selectRefundChannels: (channels, context) =>
        channels.filter(channel => {
          if (BigInt(channel.balance) === 0n) return false;
          if (channel.pendingRequest && channel.pendingRequest.expiresAt > context.now) {
            return false;
          }
          return context.now - channel.lastRequestTimestamp >= 180_000; // Refund channels after 3 minutes of inactivity
        }),
      onClaim: (r: { vouchers: number; transaction: string }) =>
        console.log(`[EVM] Claimed ${r.vouchers} vouchers (tx: ${r.transaction})`),
      onSettle: (r: { transaction: string }) =>
        console.log(`[EVM] Settled to ${evmAddress} (tx: ${r.transaction})`),
      onRefund: r => console.log(`[EVM] Refunded channel ${r.channel} (tx: ${r.transaction})`),
      onError: (e: unknown) => console.error("[EVM] Settlement error:", e),
    });
  }

  if (svmAddress) {
    resourceServer = resourceServer.register(
      SVM_NETWORK,
      new BatchSvmScheme({
        withdrawDelay,
        ...(svmReceiverAuthorizerSigner
          ? { receiverAuthorizer: svmReceiverAuthorizerSigner.address }
          : {}),
        store: new MemoryChannelStore(),
      }),
    );
  }

  if (channelManager) {
    process.on("SIGINT", async () => {
      console.log("Shutting down — flushing pending EVM claims…");
      await channelManager!.stop({ flush: true });
      process.exit(0);
    });
  }

  const accepts = [];
  if (evmAddress) {
    accepts.push({
      scheme: "batch-settlement",
      price: maxPrice,
      network: EVM_NETWORK,
      payTo: evmAddress,
    });
  }
  if (svmAddress) {
    accepts.push({
      scheme: "batch-settlement",
      price: maxPrice,
      network: SVM_NETWORK,
      payTo: svmAddress,
    });
  }

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "GET /weather": {
      accepts,
      description: "Weather data",
      mimeType: "application/json",
    },
  });

  // Fail fast on misconfiguration: this throws the capability error (and any
  // HTTP route validation error) before the server starts accepting requests.
  await httpServer.initialize();

  app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));

  app.get("/weather", (req, res) => {
    const paymentHeader = req.header("payment-signature") ?? req.header("x-payment");
    if (paymentHeader) {
      const { accepted } = decodePaymentSignatureHeader(paymentHeader);
      // EVM batch-settlement supports charging less than the authorized max.
      // SVM batch-settlement is fixed-price: the voucher increment must equal
      // PaymentRequirements.amount.
      if (accepted.network.startsWith("eip155:")) {
        const chargedPercent = 1 + Math.floor(Math.random() * 100);
        setSettlementOverrides(res, { amount: `${chargedPercent}%` });
      }
    }

    res.send({
      report: {
        weather: "sunny",
        temperature: 70,
      },
    });
  });

  const enabledNetworks = [
    evmAddress ? "EVM (Base Sepolia)" : null,
    svmAddress ? "Solana (devnet)" : null,
  ]
    .filter(Boolean)
    .join(", ");

  app.listen(4021, () => {
    console.log("Batch-settlement server listening at http://localhost:4021");
    console.log(`  GET /weather (${enabledNetworks})`);
    if (evmAddress) {
      if (receiverAuthorizerSigner) {
        console.log(`  EVM receiver authorizer: local signer ${receiverAuthorizerSigner.address}`);
      } else {
        console.log("  EVM receiver authorizer: facilitator");
      }
    }
    if (svmAddress && svmReceiverAuthorizerSigner) {
      console.log(`  SVM receiver authorizer: ${svmReceiverAuthorizerSigner.address}`);
    }
  });
}

main().catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});
