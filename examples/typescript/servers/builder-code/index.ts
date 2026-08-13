import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { BUILDER_CODE, declareBuilderCodeExtension } from "@x402/extensions/builder-code";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("❌ EVM_ADDRESS environment variable is required");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}

const appBuilderCode = process.env.APP_BUILDER_CODE;
if (!appBuilderCode) {
  console.error("❌ APP_BUILDER_CODE environment variable is required");
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const resourceServer = new x402ResourceServer(facilitatorClient).register(
  "eip155:84532",
  new ExactEvmScheme(),
);

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
          [BUILDER_CODE]: declareBuilderCodeExtension(appBuilderCode),
        },
      },
    },
    resourceServer,
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
