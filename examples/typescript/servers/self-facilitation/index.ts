import { x402Facilitator } from "@x402/core/facilitator";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { config } from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, polygon, polygonAmoy } from "viem/chains";

config();

if (!process.env.EVM_PRIVATE_KEY) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const evmAccount = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const evmNetwork = (process.env.EVM_NETWORK ?? "eip155:84532") as
  | "eip155:84532"
  | "eip155:8453"
  | "eip155:137"
  | "eip155:80002";
const evmRpcUrl = process.env.EVM_RPC_URL;

const chainConfig = {
  "eip155:84532": { chain: baseSepolia, label: "Base Sepolia" },
  "eip155:8453": { chain: base, label: "Base Mainnet" },
  "eip155:137": { chain: polygon, label: "Polygon Mainnet" },
  "eip155:80002": { chain: polygonAmoy, label: "Polygon Amoy" },
} as const;

const selectedNetwork = chainConfig[evmNetwork];
if (!selectedNetwork) {
  console.error(
    "Unsupported EVM_NETWORK. Supported values: eip155:84532, eip155:8453, eip155:137, eip155:80002",
  );
  process.exit(1);
}

// 1) Build facilitator signer from an on-chain client.
const viemClient = createWalletClient({
  account: evmAccount,
  chain: selectedNetwork.chain,
  transport: http(evmRpcUrl),
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
  networks: evmNetwork,
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
            network: evmNetwork,
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
    }).register(evmNetwork, new ExactEvmServerScheme()),
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
  console.log(`Server listening at http://localhost:${4021} using ${selectedNetwork.label} (${evmNetwork})`);
});
