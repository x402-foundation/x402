import { HTTPFacilitatorClient } from "@x402/core/server";
import { BatchSettlementEvmScheme, FileChannelStorage } from "@x402/evm/batch-settlement/server";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";
import { config } from "dotenv";
import express from "express";
import { privateKeyToAccount } from "viem/accounts";

config();

const NETWORK = "eip155:84532" as const;

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const receiverAuthorizerPrivateKey = process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY as
  | `0x${string}`
  | undefined;
const storageDir = process.env.STORAGE_DIR;
const withdrawDelay = Number(process.env.DEFERRED_WITHDRAW_DELAY_SECONDS ?? "86400");

if (!evmAddress || !/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) {
  console.error("Missing or invalid EVM_ADDRESS (checksummed 20-byte hex, 0x-prefixed)");
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

const batchedScheme = new BatchSettlementEvmScheme(evmAddress, {
  ...(receiverAuthorizerSigner ? { receiverAuthorizerSigner } : {}),
  withdrawDelay,
  ...(storageDir ? { storage: new FileChannelStorage({ directory: storageDir }) } : {}),
});

const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, batchedScheme);

const channelManager = batchedScheme.createChannelManager(facilitatorClient, NETWORK);

channelManager.start({
  claimIntervalSecs: 60,
  settleIntervalSecs: 120,
  refundIntervalSecs: 180,
  maxClaimsPerBatch: 100,
  selectRefundChannels: (channels, context) =>
    channels.filter(channel => {
      if (BigInt(channel.balance) === 0n) return false;
      if (channel.pendingRequest && channel.pendingRequest.expiresAt > context.now) return false;
      return context.now - channel.lastRequestTimestamp >= 180_000; // Refund channels after 3 minutes of inactivity
    }),
  onClaim: (r: { vouchers: number; transaction: string }) =>
    console.log(`Claimed ${r.vouchers} vouchers (tx: ${r.transaction})`),
  onSettle: (r: { transaction: string }) =>
    console.log(`Settled to ${evmAddress} (tx: ${r.transaction})`),
  onRefund: r => console.log(`Refunded channel ${r.channel} (tx: ${r.transaction})`),
  onError: (e: unknown) => console.error("Settlement error:", e),
});

process.on("SIGINT", async () => {
  console.log("Shutting down — flushing pending claims…");
  await channelManager.stop({ flush: true });
  process.exit(0);
});

const app = express();

// Authorize up to this amount per request; optional usage-based override below bills actual usage.
const maxPrice = "$0.01";

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "batch-settlement",
          price: maxPrice,
          network: NETWORK,
          payTo: evmAddress,
        },
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/weather", (req, res) => {
  const chargedPercent = 1 + Math.floor(Math.random() * 100);
  setSettlementOverrides(res, { amount: `${chargedPercent}%` });

  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.listen(4021, () => {
  console.log("Batch-settlement server listening at http://localhost:4021");
  console.log("  GET /weather");
  if (receiverAuthorizerSigner) {
    console.log(`  Receiver authorizer: local signer ${receiverAuthorizerSigner.address}`);
  } else {
    console.log("  Receiver authorizer: facilitator");
  }
});
