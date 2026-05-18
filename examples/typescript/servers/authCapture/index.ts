import { AuthCaptureEvmScheme as AuthCaptureEvmServer } from "@x402/evm/authCapture/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { config } from "dotenv";
import express from "express";
import { isAddress, zeroAddress } from "viem";

config();

const NETWORK = "eip155:84532" as const;
const PORT = Number(process.env.PORT?.trim() || "4021");

const evmAddress = process.env.EVM_ADDRESS?.trim() as `0x${string}` | undefined;
const captureAuthorizer = process.env.CAPTURE_AUTHORIZER?.trim() as `0x${string}` | undefined;
const facilitatorUrl = process.env.FACILITATOR_URL?.trim();

if (!evmAddress || !isAddress(evmAddress)) {
  console.error("Missing or invalid EVM_ADDRESS");
  process.exit(1);
}
if (!captureAuthorizer || !isAddress(captureAuthorizer)) {
  console.error("Missing or invalid CAPTURE_AUTHORIZER");
  process.exit(1);
}
if (!facilitatorUrl) {
  console.error("Missing FACILITATOR_URL");
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new AuthCaptureEvmServer(),
);

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "authCapture",
          price: "$0.01",
          network: NETWORK,
          payTo: evmAddress,
          extra: {
            captureAuthorizer,
            // Capture / refund windows are seconds-from-now relative offsets.
            // The scheme converts them to absolute Unix-second deadlines per
            // request inside `enhancePaymentRequirements`, so each
            // authorization carries a fresh window. The values are arbiter
            // policy: pick what your captureAuthorizer actually supports.
            captureDeadlineSeconds: 30 * 86400,
            refundDeadlineSeconds: 60 * 86400,
            // address(0) lets the captureAuthorizer pick any non-zero fee
            // recipient at capture/charge time (deferred selection, per spec).
            // Production setups can pin a specific receiver instead.
            feeRecipient: zeroAddress,
            minFeeBps: 0,
            maxFeeBps: 100,
          },
        },
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/weather", (_req, res) => {
  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.listen(PORT, () => {
  console.log(`authCapture server listening at http://localhost:${PORT}`);
  console.log("  GET /weather");
  console.log(`  Pay-to:            ${evmAddress}`);
  console.log(`  captureAuthorizer: ${captureAuthorizer}`);
});
