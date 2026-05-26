import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
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
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: "eip155:84532",
          payTo: evmAddress,
        },
        description: "Weather data",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { city: "San Francisco" },
            inputSchema: {
              properties: {
                city: { type: "string" },
              },
              required: ["city"],
            },
            output: {
              example: {
                city: "San Francisco",
                weather: "foggy",
                temperature: 60,
              },
            },
          }),
        },
      },
    },
    new x402ResourceServer(facilitatorClient).register("eip155:84532", new ExactEvmScheme()),
  ),
);

app.get("/weather", (req, res) => {
  const city = (req.query.city as string) || "San Francisco";

  const weatherData: Record<string, { weather: string; temperature: number }> = {
    "San Francisco": { weather: "foggy", temperature: 60 },
    "New York": { weather: "cloudy", temperature: 55 },
  };

  const data = weatherData[city] || { weather: "sunny", temperature: 70 };

  res.send({
    city,
    weather: data.weather,
    temperature: data.temperature,
  });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:${4021}`);
});
