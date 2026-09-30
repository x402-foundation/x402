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
import type { BatchChannelManager } from "@x402/svm/batch-settlement/server";
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
// SVM: optional operator key. When set, the SVM route is offered server-signed
// (the operator meters and signs the actual charge) alongside a client-signed
// accept at the ceiling for clients that do not trust this operator.
const svmOperatorPrivateKey = process.env.SVM_OPERATOR_PRIVATE_KEY?.trim();
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
  let resourceServer = new x402ResourceServer(facilitatorClient);
  let channelManager: ReturnType<BatchSettlementEvmScheme["createChannelManager"]> | undefined;
  let svmChannelManager: BatchChannelManager | undefined;

  if (evmAddress) {
    const batchedEvmScheme = new BatchSettlementEvmScheme(evmAddress, {
      ...(receiverAuthorizerSigner ? { receiverAuthorizerSigner } : {}),
      withdrawDelay,
      enforceMinDeposit: false,
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

  const svmOperatorSigner = svmOperatorPrivateKey
    ? await createKeyPairSignerFromBytes(base58.decode(svmOperatorPrivateKey))
    : undefined;

  let svmReceiverAuthorizerSigner:
    | Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>
    | undefined;

  if (svmAddress) {
    if (!svmReceiverAuthorizerPrivateKey) {
      console.error("Missing required SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY environment variable");
      process.exit(1);
    }
    svmReceiverAuthorizerSigner = await createKeyPairSignerFromBytes(
      base58.decode(svmReceiverAuthorizerPrivateKey),
    );
    const batchedSvmScheme = new BatchSvmScheme({
      withdrawDelay,
      // Advertised as extra.receiverAuthorizer; signs cooperative refunds and
      // seals of channels the payer is closing.
      receiverAuthorizer: svmReceiverAuthorizerSigner,
      ...(svmOperatorSigner ? { operator: svmOperatorSigner } : {}),
      store: new MemoryChannelStore(),
    });
    resourceServer = resourceServer.register(SVM_NETWORK, batchedSvmScheme);

    // The redemption worker claims accumulated vouchers and distributes what
    // they settle. It redeems against the same terms the 402 advertises, so
    // build them the way the resource server does: route requirements plus
    // the facilitator's /supported kind (which carries feePayer and the idle
    // window maxIdleSecs the server must claim inside).
    const supported = await facilitatorClient.getSupported();
    const svmKind = supported.kinds.find(
      kind => kind.scheme === "batch-settlement" && kind.network === SVM_NETWORK,
    );
    if (svmKind) {
      const svmRequirements = await batchedSvmScheme.enhancePaymentRequirements(
        {
          scheme: "batch-settlement",
          network: SVM_NETWORK,
          // $0.01 in USDC atomic units: the worker only reads network, asset,
          // payTo and extra.feePayer from these terms.
          amount: "10000",
          asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          payTo: svmAddress,
          maxTimeoutSeconds: 300,
          extra: {},
        },
        svmKind,
        [],
      );
      svmChannelManager = batchedSvmScheme.createChannelManager(
        facilitatorClient,
        svmRequirements,
        {
          onClaim: (r: { vouchers: number; transaction: string }) =>
            console.log(`[SVM] Claimed ${r.vouchers} vouchers (tx: ${r.transaction})`),
          onSettle: (r: { transaction: string }) =>
            console.log(`[SVM] Settled to ${svmAddress} (tx: ${r.transaction})`),
          onSeal: (r: { channel: string; transaction: string }) =>
            console.log(`[SVM] Sealed channel ${r.channel} (tx: ${r.transaction})`),
          onError: (e: unknown) => console.error("[SVM] Settlement error:", e),
        },
      );
      const svmRedemptionIntervalSecs = 60;
      // Well inside the facilitator's idle window (default seven days).
      svmChannelManager.start(svmRedemptionIntervalSecs);
      console.log(
        `[SVM] Redeeming every ${svmRedemptionIntervalSecs}s; facilitator idle window: ${String(svmKind.extra?.maxIdleSecs ?? "none")}s`,
      );
    } else {
      console.warn(
        "[SVM] facilitator does not advertise batch-settlement; no redemption worker started",
      );
    }
  }

  if (channelManager || svmChannelManager) {
    process.on("SIGINT", async () => {
      console.log("Shutting down — flushing pending claims…");
      await channelManager?.stop({ flush: true });
      await svmChannelManager?.stop({ flush: true });
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
    // With an operator configured this accept is server-signed: the client
    // signs a per-request proof and the operator signs the metered charge.
    accepts.push({
      scheme: "batch-settlement",
      price: maxPrice,
      network: SVM_NETWORK,
      payTo: svmAddress,
    });
    if (svmOperatorSigner) {
      // Clients that have not trusted this operator drop the server-signed
      // accept and pay the ceiling with their own vouchers instead.
      accepts.push({
        scheme: "batch-settlement",
        price: maxPrice,
        network: SVM_NETWORK,
        payTo: svmAddress,
        extra: { voucherSigner: "client" },
      });
    }
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
      // EVM batch-settlement supports charging less than the authorized max,
      // and so does an SVM server-signed channel (the operator signs the
      // actual charge). A client-signed SVM channel is fixed-price: the
      // voucher increment must equal PaymentRequirements.amount.
      if (accepted.network.startsWith("eip155:") || accepted.extra?.voucherSigner === "server") {
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
    if (svmAddress) {
      if (svmReceiverAuthorizerSigner) {
        console.log(
          `  SVM receiver authorizer: local signer ${svmReceiverAuthorizerSigner.address}`,
        );
      } else {
        console.log("  SVM receiver authorizer: facilitator");
      }
    }
    if (svmAddress) {
      console.log(
        svmOperatorSigner
          ? `  SVM vouchers: server-signed by operator ${svmOperatorSigner.address} (client-signed accept offered alongside)`
          : "  SVM vouchers: client-signed",
      );
    }
  });
}

main().catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});
