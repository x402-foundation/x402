import { x402Facilitator } from "@x402/core/facilitator";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { config } from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, polygon } from "viem/chains";

config();

if (!process.env.EVM_PRIVATE_KEY) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const evmAccount = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const evmNetwork = (process.env.EVM_NETWORK ?? "eip155:84532") as
  | "eip155:84532"
  | "eip155:8453"
  | "eip155:137";
const evmRpcUrl = process.env.EVM_RPC_URL?.trim() || undefined;

const chainConfig = {
  "eip155:84532": { chain: baseSepolia, label: "Base Sepolia" },
  "eip155:8453": { chain: base, label: "Base Mainnet" },
  "eip155:137": { chain: polygon, label: "Polygon Mainnet" },
} as const;

const selectedNetwork = chainConfig[evmNetwork];
if (!selectedNetwork) {
  console.error("Unsupported EVM_NETWORK. Supported values: eip155:84532, eip155:8453, eip155:137");
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
  getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }) =>
    viemClient.readContract({
      ...args,
      args: args.args || [],
    }),
  verifyTypedData: (args: {
    address: `0x${string}`;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) => viemClient.verifyTypedData(args as any),
  writeContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) =>
    viemClient.writeContract({
      ...args,
      args: args.args || [],
    }),
  sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
    viemClient.sendTransaction(args),
  waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
    viemClient.waitForTransactionReceipt(args),
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
  console.log(
    `Server listening at http://localhost:${4021} using ${selectedNetwork.label} (${evmNetwork})`,
  );
});
