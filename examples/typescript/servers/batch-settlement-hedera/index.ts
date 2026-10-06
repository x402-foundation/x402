import { HTTPFacilitatorClient } from "@x402/core/server";
import { createHederaAuthorizerSigner, parseHederaPrivateKey } from "@x402/hedera/batch-settlement";
import { BatchSettlementHederaScheme } from "@x402/hedera/batch-settlement/server";
import { FileChannelStorage } from "@x402/hedera/batch-settlement/server/file-storage";
import {
  paymentMiddlewareFromHTTPServer,
  setSettlementOverrides,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/express";
import { config } from "dotenv";
import express from "express";

config();

const NETWORK = (process.env.HEDERA_NETWORK || "hedera:testnet") as `${string}:${string}`;
const payTo = process.env.HEDERA_ACCOUNT_ID;
const facilitatorUrl = process.env.FACILITATOR_URL;
const storageDir = process.env.STORAGE_DIR;
const withdrawDelay = Number(process.env.WITHDRAW_DELAY_SECONDS ?? "86400");

if (!payTo || !/^\d+\.\d+\.\d+$/.test(payTo)) {
  console.error("Missing or invalid HEDERA_ACCOUNT_ID (expected 0.0.x)");
  process.exit(1);
}
if (!facilitatorUrl) {
  console.error("Missing required FACILITATOR_URL environment variable");
  process.exit(1);
}

const authorizerId = process.env.HEDERA_RECEIVER_AUTHORIZER_ACCOUNT_ID?.trim();
const authorizerKey = process.env.HEDERA_RECEIVER_AUTHORIZER_PRIVATE_KEY?.trim();
const receiverAuthorizerSigner =
  authorizerId && authorizerKey
    ? await createHederaAuthorizerSigner(authorizerId, parseHederaPrivateKey(authorizerKey), {
        network: NETWORK,
      })
    : undefined;

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const batchedScheme = new BatchSettlementHederaScheme(payTo, {
  ...(receiverAuthorizerSigner ? { receiverAuthorizerSigner } : {}),
  withdrawDelay,
  enforceMinDeposit: false,
  ...(storageDir ? { storage: new FileChannelStorage({ directory: storageDir }) } : {}),
});

const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, batchedScheme);

const channelManager = batchedScheme.createChannelManager(facilitatorClient, NETWORK);

channelManager.start({
  claimIntervalSecs: 60,
  settleIntervalSecs: 120,
  refundIntervalSecs: 180,
  maxClaimsPerBatch: 25,
  selectRefundChannels: (channels, context) =>
    channels.filter(channel => {
      if (BigInt(channel.balance) === 0n) return false;
      if (channel.pendingRequest && channel.pendingRequest.expiresAt > context.now) return false;
      return context.now - channel.lastRequestTimestamp >= 180_000; // idle for 3 minutes
    }),
  onClaim: r => console.log(`Claimed ${r.vouchers} vouchers (tx: ${r.transaction})`),
  onSettle: r => console.log(`Settled to ${payTo} (tx: ${r.transaction})`),
  onRefund: r => console.log(`Refunded channel ${r.channel} (tx: ${r.transaction})`),
  onError: e => console.error("Settlement error:", e),
});

process.on("SIGINT", async () => {
  console.log("Shutting down — flushing pending claims…");
  await channelManager.stop({ flush: true });
  process.exit(0);
});

const app = express();

// Authorize up to this amount per request; the handler bills actual usage below.
const maxPrice = "$0.01";

const httpServer = new x402HTTPResourceServer(resourceServer, {
  "GET /weather": {
    accepts: {
      scheme: "batch-settlement",
      price: maxPrice,
      network: NETWORK,
      payTo,
    },
    description: "Weather data",
    mimeType: "application/json",
  },
});

/**
 * Initializes facilitator capability checks and starts the batch-settlement server.
 */
async function main() {
  await httpServer.initialize();

  app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));

  app.get("/weather", (req, res) => {
    const chargedPercent = 1 + Math.floor(Math.random() * 100);
    setSettlementOverrides(res, { amount: `${chargedPercent}%` });
    res.send({ report: { weather: "sunny", temperature: 70 } });
  });

  app.listen(4021, () => {
    console.log("Hedera batch-settlement server listening at http://localhost:4021");
    console.log("  GET /weather");
    console.log(
      receiverAuthorizerSigner
        ? `  Receiver authorizer: local signer ${authorizerId}`
        : "  Receiver authorizer: facilitator",
    );
  });
}

main().catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});
