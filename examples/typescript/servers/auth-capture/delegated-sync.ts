import { HTTPFacilitatorClient } from "@x402/core/server";
import { AuthCaptureEvmScheme } from "@x402/evm/auth-capture/server";
import {
  paymentMiddlewareFromHTTPServer,
  setSettlementOverrides,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/express";
import { config } from "dotenv";
import express from "express";
import { getAddress, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

config();

const NETWORK = "eip155:84532" as const;
const PORT = 4021;

const payTo = process.env.EVM_ADDRESS?.trim();
const facilitatorUrl = process.env.FACILITATOR_URL?.trim();
const receiverAuthorizerPrivateKey = process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY?.trim() as
  | `0x${string}`
  | undefined;

if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
  console.error("Missing or invalid EVM_ADDRESS (checksummed 20-byte hex, 0x-prefixed)");
  process.exit(1);
}

if (!facilitatorUrl) {
  console.error("Missing required FACILITATOR_URL environment variable");
  process.exit(1);
}

if (!receiverAuthorizerPrivateKey) {
  console.error(
    "Missing EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY (required for delegated sync lifecycle)",
  );
  process.exit(1);
}

const receiverAuthorizerSigner = privateKeyToAccount(receiverAuthorizerPrivateKey);
const payToAddress = getAddress(payTo) as `0x${string}`;

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const scheme = new AuthCaptureEvmScheme({
  receiverAuthorizerSigner,
});

const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, scheme);
const httpServer = new x402HTTPResourceServer(resourceServer, {
  "GET /weather": {
    accepts: {
      scheme: "auth-capture",
      price: "$0.01",
      network: NETWORK,
      payTo: payToAddress,
      extra: {
        feeRecipient: zeroAddress,
        minFeeBps: 0,
        maxFeeBps: 0,
        captureDeadlineSeconds: 3600,
        refundDeadlineSeconds: 7200,
        operatorType: "delegated",
        paymentFlow: "escrow",
        captureMode: "sync",
      },
    },
    description: "Weather data",
    mimeType: "application/json",
  },
});

const app = express();

/**
 * Starts the resource server for the delegated escrow, sync capture flow.
 */
async function main(): Promise<void> {
  await httpServer.initialize();

  app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));

  app.get("/weather", (_req, res) => {
    const chargedPercent = 1 + Math.floor(Math.random() * 100);
    setSettlementOverrides(res, { amount: `${chargedPercent}%` });

    res.send({
      report: {
        weather: "sunny",
        temperature: 70,
        flow: "delegated-sync",
      },
    });
  });

  app.listen(PORT, () => {
    console.log(`Auth-capture server (delegated-sync) listening at http://localhost:${PORT}`);
    console.log("  GET /weather");
    console.log(`  Receiver authorizer: ${receiverAuthorizerSigner.address}`);
    console.log("  Capture authorizer: copied from facilitator /supported extra.captureAuthorizer");
  });
}

main().catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});
