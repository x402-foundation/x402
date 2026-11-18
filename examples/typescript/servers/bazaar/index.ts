import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const svmAddress = process.env.SVM_ADDRESS;
if (!evmAddress || !svmAddress) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("FACILITATOR_URL environment variable is required");
  process.exit(1);
}
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const app = express();

const paymentOptions = [
  {
    scheme: "exact" as const,
    price: "$0.001",
    network: "eip155:84532",
    payTo: evmAddress,
  },
  {
    scheme: "exact" as const,
    price: "$0.001",
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    payTo: svmAddress,
  },
];

app.use(
  paymentMiddleware(
    {
      // Single path param: /weather/:city
      "GET /weather/:city": {
        accepts: paymentOptions,
        description: "Weather data for a city",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            pathParamsSchema: {
              properties: { city: { type: "string", description: "City name slug" } },
              required: ["city"],
            },
            output: {
              example: { city: "san-francisco", weather: "foggy", temperature: 60 },
            },
          }),
        },
      },

      // Multiple path params: /weather/:country/:city
      // Param names are matched by position in the URL, not by declaration order in the schema.
      // /weather/us/san-francisco -> { country: "us", city: "san-francisco" }
      "GET /weather/:country/:city": {
        accepts: paymentOptions,
        description: "Weather data for a city in a specific country",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            pathParamsSchema: {
              properties: {
                country: { type: "string", description: "Country code" },
                city: { type: "string", description: "City name slug" },
              },
              required: ["country", "city"],
            },
            output: {
              example: { country: "us", city: "san-francisco", weather: "foggy", temperature: 60 },
            },
          }),
        },
      },
    },
    new x402ResourceServer(facilitatorClient)
      .register("eip155:84532", new ExactEvmScheme())
      .register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmScheme()),
  ),
);

app.get("/weather/:city", (req, res) => {
  const { city } = req.params;

  const weatherData: Record<string, { weather: string; temperature: number }> = {
    "san-francisco": { weather: "foggy", temperature: 60 },
    "new-york": { weather: "cloudy", temperature: 55 },
    tokyo: { weather: "rainy", temperature: 65 },
  };

  const data = weatherData[city] || { weather: "sunny", temperature: 70 };
  res.send({ city, weather: data.weather, temperature: data.temperature });
});

app.get("/weather/:country/:city", (req, res) => {
  const { country, city } = req.params;

  const weatherData: Record<string, Record<string, { weather: string; temperature: number }>> = {
    us: {
      "san-francisco": { weather: "foggy", temperature: 60 },
      "new-york": { weather: "cloudy", temperature: 55 },
    },
    jp: {
      tokyo: { weather: "rainy", temperature: 65 },
      osaka: { weather: "clear", temperature: 72 },
    },
  };

  const data = weatherData[country]?.[city] || { weather: "sunny", temperature: 70 };
  res.send({ country, city, weather: data.weather, temperature: data.temperature });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:${4021}`);
});
