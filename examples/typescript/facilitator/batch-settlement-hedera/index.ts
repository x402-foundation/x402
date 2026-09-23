import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  createFacilitatorHederaBatchSigner,
  createHederaAuthorizerSigner,
  type HederaAuthorizerSigner,
  parseHederaPrivateKey,
} from "@x402/hedera/batch-settlement";
import { BatchSettlementHederaScheme } from "@x402/hedera/batch-settlement/facilitator";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const PORT = process.env.PORT || "4022";
const NETWORK = (process.env.HEDERA_NETWORK || "hedera:testnet") as `${string}:${string}`;

if (!process.env.HEDERA_ACCOUNT_ID || !process.env.HEDERA_PRIVATE_KEY) {
  console.error("❌ HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY are required");
  process.exit(1);
}

const signer = createFacilitatorHederaBatchSigner({
  accountId: process.env.HEDERA_ACCOUNT_ID,
  privateKey: parseHederaPrivateKey(process.env.HEDERA_PRIVATE_KEY),
  network: NETWORK,
  ...(process.env.HEDERA_MIRROR_NODE_URL
    ? { mirrorNodeUrl: process.env.HEDERA_MIRROR_NODE_URL }
    : {}),
});

// Optional receiver authorizer (signs ClaimBatch / Refund digests with a Hedera account key)
let authorizerSigner: HederaAuthorizerSigner | undefined;
const authorizerId = process.env.HEDERA_RECEIVER_AUTHORIZER_ACCOUNT_ID?.trim();
const authorizerKey = process.env.HEDERA_RECEIVER_AUTHORIZER_PRIVATE_KEY?.trim();
if (authorizerId && authorizerKey) {
  authorizerSigner = await createHederaAuthorizerSigner(
    authorizerId,
    parseHederaPrivateKey(authorizerKey),
    { network: NETWORK },
  );
}

console.info(`Hedera facilitator account: ${process.env.HEDERA_ACCOUNT_ID} (${NETWORK})`);
console.info(
  authorizerSigner
    ? `Receiver authorizer: ${authorizerId} (${authorizerSigner.address})`
    : "Receiver authorizer: not configured",
);

const facilitator = new x402Facilitator()
  .onAfterVerify(async context => {
    console.log("After verify", context.result);
  })
  .onAfterSettle(async context => {
    console.log("After settle", context.result);
  })
  .onSettleFailure(async context => {
    console.log("Settle failure", context.error);
  });

facilitator.register(NETWORK, new BatchSettlementHederaScheme(signer, authorizerSigner));

const app = express();
app.use(express.json({ limit: "1mb" }));

app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
    }
    const response: VerifyResponse = await facilitator.verify(paymentPayload, paymentRequirements);
    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
    }
    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );
    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);
    if (error instanceof Error && error.message.includes("Settlement aborted:")) {
      return res.json({
        success: false,
        errorReason: error.message.replace("Settlement aborted: ", ""),
        network: req.body?.paymentPayload?.accepted?.network || "unknown",
      } as SettleResponse);
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/supported", async (_req, res) => {
  try {
    res.json(facilitator.getSupported());
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.listen(parseInt(PORT), () => {
  console.log(`🚀 Hedera batch-settlement facilitator listening on http://localhost:${PORT}`);
});
