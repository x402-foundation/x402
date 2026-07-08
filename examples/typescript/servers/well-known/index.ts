import http from "node:http";
import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

config();

const PORT = Number(process.env.PORT ?? 4022);
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // Solana Devnet
const SVM_ADDRESS = process.env.SVM_ADDRESS ?? "GsbwXfJraMomNxBcjK1WUKHzNSwjyZqdQVAtJgRXrUL5";

/**
 * Resolve the facilitator URL. If FACILITATOR_URL is not set, start a tiny local
 * stub that only answers `GET /supported` — enough to run this discovery demo
 * fully offline with no keys. Set FACILITATOR_URL to use a real facilitator instead.
 *
 * @returns The facilitator base URL to use.
 */
function resolveFacilitatorUrl(): string {
  if (process.env.FACILITATOR_URL) {
    return process.env.FACILITATOR_URL;
  }
  const stubPort = 4099;
  const stub = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/supported")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: NETWORK,
              extra: { feePayer: SVM_ADDRESS },
            },
          ],
          extensions: [],
          signers: {},
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  stub.listen(stubPort, () => console.log(`[stub facilitator] listening on :${stubPort}`));
  return `http://localhost:${stubPort}`;
}

const facilitatorUrl = resolveFacilitatorUrl();
const app = express();

// There is NO `app.get("/.well-known/x402.json", ...)` below. The x402 middleware
// serves the per-origin discovery manifest automatically (default-on), assembled
// from these routes. Pass `false` as the last argument to paymentMiddleware to opt out.
app.use(
  paymentMiddleware(
    {
      "GET /weather/:city": {
        accepts: [{ scheme: "exact", price: "$0.001", network: NETWORK, payTo: SVM_ADDRESS }],
        description: "Weather data for a city",
        mimeType: "application/json",
        serviceName: "Example Weather",
        tags: ["weather"],
        extensions: {
          ...declareDiscoveryExtension({
            pathParamsSchema: {
              properties: { city: { type: "string", description: "City name slug" } },
              required: ["city"],
            },
            output: { example: { city: "san-francisco", weather: "foggy", temperature: 60 } },
          }),
        },
      },
    },
    new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl })).register(
      NETWORK,
      new ExactSvmScheme(),
    ),
  ),
);

app.get("/weather/:city", (req, res) => {
  res.send({ city: req.params.city, weather: "foggy", temperature: 60 });
});

app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
  console.log(`Discovery manifest auto-served at http://localhost:${PORT}/.well-known/x402.json`);
  console.log(`Try:  curl -s http://localhost:${PORT}/.well-known/x402.json | jq`);
});
