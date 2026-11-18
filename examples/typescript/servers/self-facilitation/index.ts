import { x402Facilitator } from "@x402/core/facilitator";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { config } from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

config();

if (!process.env.EVM_PRIVATE_KEY) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const evmAccount = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);

// 1) Build facilitator signer from an on-chain client.
const viemClient = createWalletClient({
  account: evmAccount,
  chain: baseSepolia,
  transport: http(),
}).extend(publicActions);

const evmSigner = toFacilitatorEvmSigner({
  address: evmAccount.address,
  getCode: viemClient.getCode,
  readContract: viemClient.readContract,
  verifyTypedData: viemClient.verifyTypedData,
  writeContract: viemClient.writeContract,
  sendTransaction: viemClient.sendTransaction,
  waitForTransactionReceipt: viemClient.waitForTransactionReceipt,
});

// 2) Build an in-process facilitator and register supported scheme/network.
const facilitator = new x402Facilitator();
registerExactEvmScheme(facilitator, {
  signer: evmSigner,
  networks: "eip155:84532", // Base Sepolia
});

// 3) Use standard express middleware wired to the local facilitator.
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
            payTo: evmAccount.address,
          },
        ],
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer({
      verify: facilitator.verify.bind(facilitator),
      settle: facilitator.settle.bind(facilitator),
      getSupported: async () => facilitator.getSupported(),
    }).register("eip155:84532", new ExactEvmServerScheme()),
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

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:${4021}`);
});
