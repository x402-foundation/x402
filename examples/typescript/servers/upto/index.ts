import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareEip2612GasSponsoringExtension } from "@x402/extensions";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("Missing required EVM_ADDRESS environment variable");
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

app.use(
  paymentMiddleware(
    {
      "GET /api/generate": {
        accepts: {
          scheme: "upto",
          price: maxPrice,
          network: "eip155:84532",
          payTo: evmAddress,
        },
        description: "AI text generation — billed by token usage",
        mimeType: "application/json",
        extensions: {
          ...declareEip2612GasSponsoringExtension(),
        },
      },
    },
    new x402ResourceServer(facilitatorClient).register("eip155:84532", new UptoEvmScheme()),
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

app.listen(4021, () => {
  console.log("Upto server listening at http://localhost:4021");
  console.log("  GET /api/generate  — usage-based billing via upto scheme");
});
