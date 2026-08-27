import { HTTPFacilitatorClient } from "@x402/core/server";
import { AuthCaptureEvmScheme } from "@x402/evm/auth-capture/server";
import {
  paymentMiddlewareFromHTTPServer,
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
    "Missing EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY (required for delegated deferred lifecycle)",
  );
  process.exit(1);
}

const receiverAuthorizerSigner = privateKeyToAccount(receiverAuthorizerPrivateKey);
const payToAddress = getAddress(payTo) as `0x${string}`;

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const scheme = new AuthCaptureEvmScheme({
  receiverAuthorizerSigner,
});
const lifecycle = scheme.createLifecycleManager(facilitatorClient);

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
        captureMode: "deferred",
      },
    },
    description: "Weather data",
    mimeType: "application/json",
  },
});

const app = express();

/**
 * Starts the resource server for the delegated escrow, deferred capture flow.
 */
async function main(): Promise<void> {
  await httpServer.initialize();

  app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));
  app.use(express.json());

  app.get("/admin/payments", async (_req, res) => {
    try {
      const payments = await lifecycle.listAuthorizedPayments();
      res.json(
        payments.map(payment => ({
          paymentInfoHash: payment.paymentInfoHash,
          capturableAmount: payment.capturableAmount,
          refundableAmount: payment.refundableAmount,
          collectTransaction: payment.collectTransaction,
          createdAt: payment.createdAt,
        })),
      );
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.post("/admin/capture", async (req, res) => {
    try {
      const paymentInfoHash = req.body?.paymentInfoHash as `0x${string}` | undefined;
      if (!paymentInfoHash) {
        return res.status(400).json({ error: "paymentInfoHash is required" });
      }

      const amount = req.body?.amount as string | undefined;
      const voidRemainder = Boolean(req.body?.voidRemainder);

      const response = await lifecycle.capture(
        paymentInfoHash,
        amount ? { amount, voidRemainder } : undefined,
      );
      res.json(response);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.post("/admin/void", async (req, res) => {
    try {
      const paymentInfoHash = req.body?.paymentInfoHash as `0x${string}` | undefined;
      if (!paymentInfoHash) {
        return res.status(400).json({ error: "paymentInfoHash is required" });
      }

      const response = await lifecycle.voidPayment(paymentInfoHash);
      res.json(response);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/weather", (_req, res) => {
    res.send({
      report: {
        weather: "sunny",
        temperature: 70,
        flow: "delegated-deferred",
      },
    });
  });

  app.listen(PORT, () => {
    console.log(`Auth-capture server (delegated-deferred) listening at http://localhost:${PORT}`);
    console.log("  GET /weather");
    console.log("  GET /admin/payments");
    console.log("  POST /admin/capture  { paymentInfoHash, amount?, voidRemainder? }");
    console.log("  POST /admin/void     { paymentInfoHash }");
    console.log("  Deferred captures use in-memory storage — call admin routes before restart.");
    console.log(`  Receiver authorizer: ${receiverAuthorizerSigner.address}`);
    console.log("  Capture authorizer: copied from facilitator /supported extra.captureAuthorizer");
  });
}

main().catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});
