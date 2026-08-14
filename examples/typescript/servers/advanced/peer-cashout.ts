import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createCashClient, formatUsdc, isCashError, prepareResultToJson, usdc } from "@zkp2p/cash";
import type { CurrencyType } from "@zkp2p/cash";

config();

const payTo = process.env.EVM_ADDRESS as `0x${string}`;
const facilitatorUrl = process.env.FACILITATOR_URL;
const payoutPlatform = process.env.PEER_CASH_PLATFORM;
const payoutCurrency = process.env.PEER_CASH_CURRENCY;
const payoutPayee = process.env.PEER_CASH_PAYEE;

if (!payTo || !facilitatorUrl || !payoutPlatform || !payoutCurrency || !payoutPayee) {
  throw new Error(
    "EVM_ADDRESS, FACILITATOR_URL, PEER_CASH_PLATFORM, PEER_CASH_CURRENCY, and PEER_CASH_PAYEE are required",
  );
}

const cashoutThreshold = usdc(process.env.CASHOUT_THRESHOLD_USDC ?? "10");
const cash = createCashClient({ environment: "production" });
let settledUsdc = 0n;

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
  .register("eip155:8453", new ExactEvmScheme())
  .onAfterSettle(async ({ requirements, result }) => {
    settledUsdc += BigInt(requirements.amount);
    console.log(
      `x402 payment settled: ${formatUsdc(BigInt(requirements.amount))} USDC (${result.transaction})`,
    );

    if (settledUsdc >= cashoutThreshold) {
      console.log(
        `${formatUsdc(settledUsdc)} USDC is ready to prepare at http://127.0.0.1:4022/cashout`,
      );
    }
  });

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "exact",
          price: "$0.01",
          network: "eip155:8453",
          payTo,
        },
        description: "Weather data funded by an x402 payment",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/weather", (_req, res) => {
  res.json({ weather: "sunny", temperature: 70 });
});

app.listen(4021, () => {
  console.log("x402 server listening at http://localhost:4021");
});

// Keep the cash-out planner off the public interface. It returns unsigned
// transactions; the wallet that received the x402 revenue retains custody and
// decides whether to sign and submit them.
const admin = express();
admin.use(express.json());
admin.post("/cashout", async (req, res) => {
  try {
    const requested = (req.body as { amountUsdc?: unknown }).amountUsdc;
    if (requested !== undefined && typeof requested !== "string") {
      res.status(400).json({ error: "amountUsdc must be a decimal string" });
      return;
    }
    if (requested !== undefined && !/^\d+(\.\d{1,6})?$/.test(requested)) {
      res.status(400).json({ error: "amountUsdc must have at most six decimal places" });
      return;
    }
    if (settledUsdc < cashoutThreshold) {
      res.status(409).json({
        error: "tracked x402 settlements have not reached the cash-out threshold",
        settledUsdc: formatUsdc(settledUsdc),
        thresholdUsdc: formatUsdc(cashoutThreshold),
      });
      return;
    }

    const amount = requested === undefined ? settledUsdc : usdc(requested);
    if (amount <= 0n || amount > settledUsdc) {
      res.status(409).json({
        error: "cash-out amount must be positive and no greater than tracked x402 settlements",
        settledUsdc: formatUsdc(settledUsdc),
      });
      return;
    }

    const prepared = await cash.prepare({
      amount,
      receive: {
        platform: payoutPlatform,
        currency: payoutCurrency as CurrencyType,
        payee: payoutPayee,
      },
    });

    res.json({
      amountUsdc: formatUsdc(amount),
      note: "Unsigned only. Persist settlement and confirmed cash-out state in production.",
      prepared: prepareResultToJson(prepared),
    });
  } catch (error) {
    if (isCashError(error)) {
      res.status(400).json({ error: error.toJSON() });
      return;
    }
    console.error("Unable to prepare Peer cash-out", error);
    res.status(500).json({ error: "Unable to prepare Peer cash-out" });
  }
});

admin.listen(4022, "127.0.0.1", () => {
  console.log("cash-out planner listening at http://127.0.0.1:4022");
});
