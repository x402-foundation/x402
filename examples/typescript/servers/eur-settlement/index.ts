import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
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
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: "eip155:84532",
            payTo: evmAddress,
          },
        ],
        description: "European weather data",
        mimeType: "application/json",
      },
      "GET /market-data": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.01",
            network: "eip155:84532",
            payTo: evmAddress,
          },
        ],
        description: "European market indices",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register("eip155:84532", new ExactEvmScheme()),
  ),
);

app.get("/weather", (_, res) => {
  res.send({
    report: {
      city: "Berlin",
      weather: "partly cloudy",
      temperature: 18,
      unit: "celsius",
    },
  });
});

app.get("/market-data", (_, res) => {
  res.send({
    market: "EU",
    indices: {
      "EURO STOXX 50": { value: 5142.3, change: "+0.8%" },
      DAX: { value: 18654.7, change: "+1.1%" },
      CAC40: { value: 7832.1, change: "+0.5%" },
    },
    timestamp: new Date().toISOString(),
  });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:${4021}`);
});
