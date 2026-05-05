/**
 * Permit2 gas sponsorship facilitator example (`exact` + `upto`)
 *
 * Registers both `exact` and `upto` EVM schemes on Base Sepolia and advertises the two
 * gas-sponsoring extensions: EIP-2612 permits and ERC-20 `approve` transactions (tokens
 * without EIP-2612). Both schemes use Permit2 paths that can pair with these extensions.
 *
 * Requires `EVM_PRIVATE_KEY` with Base Sepolia ETH for settlement and for broadcasting
 * client-supplied approval transactions when those extensions are used.
 */

import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { UptoEvmScheme } from "@x402/evm/upto/facilitator";
import {
  EIP2612_GAS_SPONSORING,
  createErc20ApprovalGasSponsoringExtension,
} from "@x402/extensions";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

dotenv.config();

const PORT = process.env.PORT || "4022";
const EVM_NETWORK = "eip155:84532";

if (!process.env.EVM_PRIVATE_KEY) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

const evmAccount = privateKeyToAccount(
  process.env.EVM_PRIVATE_KEY as `0x${string}`,
);
console.info(`EVM Facilitator account: ${evmAccount.address}`);

const viemClient = createWalletClient({
  account: evmAccount,
  chain: baseSepolia,
  transport: http(),
}).extend(publicActions);

const evmSigner = toFacilitatorEvmSigner({
  getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
  address: evmAccount.address,
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

const facilitator = new x402Facilitator()
  .onBeforeVerify(async (context) => {
    console.log("Before verify", context);
  })
  .onAfterVerify(async (context) => {
    console.log("After verify", context);
  })
  .onVerifyFailure(async (context) => {
    console.log("Verify failure", context);
  })
  .onBeforeSettle(async (context) => {
    console.log("Before settle", context);
  })
  .onAfterSettle(async (context) => {
    console.log("After settle", context);
  })
  .onSettleFailure(async (context) => {
    console.log("Settle failure", context);
  });

facilitator.register(
  EVM_NETWORK,
  new ExactEvmScheme(evmSigner, { deployERC4337WithEIP6492: true }),
);
facilitator.register(EVM_NETWORK, new UptoEvmScheme(evmSigner));

const erc20ApprovalSigner = {
  ...evmSigner,
  sendTransactions: async (
    transactions: (
      | `0x${string}`
      | { to: `0x${string}`; data: `0x${string}`; gas?: bigint }
    )[],
  ): Promise<`0x${string}`[]> => {
    const hashes: `0x${string}`[] = [];
    for (const tx of transactions) {
      let hash: `0x${string}`;
      if (typeof tx === "string") {
        hash = await viemClient.sendRawTransaction({
          serializedTransaction: tx,
        });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        hash = await viemClient.sendTransaction(tx as any);
      }
      const receipt = await viemClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`transaction_failed: ${hash}`);
      }
      hashes.push(hash);
    }
    return hashes;
  },
};

facilitator
  .registerExtension(EIP2612_GAS_SPONSORING)
  .registerExtension(
    createErc20ApprovalGasSponsoringExtension(erc20ApprovalSigner),
  );

const app = express();
app.use(express.json());

app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: VerifyResponse = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);

    if (
      error instanceof Error &&
      error.message.includes("Settlement aborted:")
    ) {
      return res.json({
        success: false,
        errorReason: error.message.replace("Settlement aborted: ", ""),
        network: req.body?.paymentPayload?.network || "unknown",
      } as SettleResponse);
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/supported", async (req, res) => {
  try {
    const response = facilitator.getSupported();
    res.json(response);
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(parseInt(PORT), () => {
  console.log(
    `🚀 Gas extensions facilitator (exact + upto) listening on http://localhost:${PORT}`,
  );
  console.log(
    `   Extensions: eip2612GasSponsoring, erc20ApprovalGasSponsoring`,
  );
  console.log();
});
