import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { convertToTokenAmount } from "@x402/core/utils";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const svmAddress = process.env.SVM_ADDRESS;
if (!evmAddress || !svmAddress) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: "eip155:84532",
          payTo: evmAddress,
        },
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register(
      "eip155:84532",
      new ExactEvmScheme().registerMoneyParser(async (amount, network) => {
        // Custom money parser such that on the Gnosis Chain (xDai) network, we use Wrapped XDAI (WXDAI) when describing money
        // NOTE: Wrapped XDAI is not an EIP-3009 complaint token, and would fail the current ExactEvm implementation. This example is for demonstration purposes
        if (network == "eip155:100") {
          return {
            amount: convertToTokenAmount(String(amount), 18),
            asset: "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d",
            extra: { token: "Wrapped XDAI" },
          };
        }
        return null;
      }),
    ),
  ),
);

app.get("/weather", (req, res) => {
  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:${4021}`);
});
