import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { UptoSvmScheme } from "@x402/svm/upto/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareEip2612GasSponsoringExtension } from "@x402/extensions";
import type { Network } from "@x402/core/types";
config();

const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network;
const EVM_NETWORK = "eip155:84532" as Network;

const evmAddress = process.env.EVM_ADDRESS as `0x${string}` | undefined;
const svmAddress = process.env.SVM_ADDRESS;
const svmReceiverAuthorizerKey = process.env.SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY;
if (!evmAddress && !svmAddress) {
  console.error("Missing required EVM_ADDRESS or SVM_ADDRESS environment variable");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("Missing required FACILITATOR_URL environment variable");
  process.exit(1);
}
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const app = express();

// The "upto" scheme authorizes up to a maximum amount but settles only what you specify.
// This enables usage-based billing: authorize a ceiling, then charge actual usage.
const maxPrice = "$0.10"; // Maximum the client authorizes (10 cents)

const accepts = [];
if (evmAddress) {
  accepts.push({
    scheme: "upto",
    price: maxPrice,
    network: EVM_NETWORK,
    payTo: evmAddress,
  });
}
if (svmAddress) {
  accepts.push({
    scheme: "upto",
    price: maxPrice,
    network: SOLANA_DEVNET,
    payTo: svmAddress,
  });
}

const receiverAuthorizerSigner = svmReceiverAuthorizerKey
  ? await createKeyPairSignerFromBytes(base58.decode(svmReceiverAuthorizerKey))
  : undefined;

let resourceServer = new x402ResourceServer(facilitatorClient);
if (evmAddress) resourceServer = resourceServer.register(EVM_NETWORK, new UptoEvmScheme());
if (svmAddress && receiverAuthorizerSigner) {
  resourceServer = resourceServer.register(
    SOLANA_DEVNET,
    new UptoSvmScheme({
      receiverAuthorizerSigner,
      rpcUrl: process.env.SVM_RPC_URL,
    }),
  );
} else if (svmAddress && !receiverAuthorizerSigner) {
  console.error(
    "SVM_ADDRESS is set but SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY is missing; " +
      "SVM upto requires a server hot key that signs settlement vouchers",
  );
  process.exit(1);
}

app.use(
  paymentMiddleware(
    {
      "GET /api/generate": {
        accepts,
        description: "AI text generation — billed by token usage",
        mimeType: "application/json",
        ...(evmAddress
          ? {
              extensions: {
                ...declareEip2612GasSponsoringExtension(),
              },
            }
          : {}),
      },
    },
    resourceServer,
  ),
);

app.get("/api/generate", (req, res) => {
  // Simulate work that produces a variable cost.
  // In production this might be LLM token count, bytes served, compute time, etc.
  const maxAmountAtomic = 100000; // 10 cents in 6-decimal USDC atomic units
  const actualUsage = Math.floor(Math.random() * (maxAmountAtomic + 1));

  // Tell the middleware to settle only what was actually used.
  setSettlementOverrides(res, { amount: String(actualUsage) });

  res.json({
    result: "Here is your generated text...",
    usage: {
      authorizedMaxAtomic: String(maxAmountAtomic),
      actualChargedAtomic: String(actualUsage),
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
  console.log("Upto server listening at http://localhost:4021");
  console.log(`  GET /api/generate  — usage-based billing via upto scheme (${enabledNetworks})`);
  if (receiverAuthorizerSigner) {
    console.log(`  SVM receiver authorizer: ${receiverAuthorizerSigner.address}`);
  }
});
