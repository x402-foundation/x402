/**
 * TypeScript Facilitator for E2E Testing
 *
 * This facilitator provides HTTP endpoints for payment verification and settlement
 * using the x402 TypeScript SDK.
 *
 * Features:
 * - Payment verification and settlement
 * - Bazaar discovery extension support
 * - Verified payment tracking (verify → settle flow)
 * - Discovery resource cataloging
 */

import {
  Account,
  Ed25519PrivateKey,
  PrivateKey,
  PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { toFacilitatorAptosSigner } from "@x402/aptos";
import { ExactAptosScheme } from "@x402/aptos/exact/facilitator";
import { toFacilitatorAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { UptoEvmScheme } from "@x402/evm/upto/facilitator";
import { ExactEvmSchemeV1 } from "@x402/evm/exact/v1/facilitator";
import { NETWORKS as EVM_V1_NETWORKS } from "@x402/evm/v1";
import { BAZAAR, extractDiscoveryInfo } from "@x402/extensions/bazaar";
import {
  EIP2612_GAS_SPONSORING,
  createErc20ApprovalGasSponsoringExtension,
} from "@x402/extensions";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import { ExactSvmSchemeV1 } from "@x402/svm/exact/v1/facilitator";
import { NETWORKS as SVM_V1_NETWORKS } from "@x402/svm/v1";
import { createEd25519Signer, type FacilitatorStellarSigner } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import crypto from "crypto";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions, Chain, parseTransaction, recoverTransactionAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import { BazaarCatalog } from "./bazaar.js";

dotenv.config();

// Configuration
const PORT = process.env.PORT || "4022";
const EVM_NETWORK = process.env.EVM_NETWORK || "eip155:84532";
const SVM_NETWORK =
  process.env.SVM_NETWORK || "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const APTOS_NETWORK = process.env.APTOS_NETWORK || "aptos:2";
const AVM_NETWORK = process.env.AVM_NETWORK || "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const STELLAR_NETWORK = process.env.STELLAR_NETWORK || "stellar:testnet";
const EVM_RPC_URL = process.env.EVM_RPC_URL;
const SVM_RPC_URL = process.env.SVM_RPC_URL;
const AVM_RPC_URL = process.env.AVM_RPC_URL;
const APTOS_RPC_URL = process.env.APTOS_RPC_URL;
const STELLAR_RPC_URL = process.env.STELLAR_RPC_URL;

// Map CAIP-2 network IDs to viem chains
function getEvmChain(network: string): Chain {
  switch (network) {
    case "eip155:8453":
      return base;
    case "eip155:84532":
    default:
      return baseSepolia;
  }
}

console.log(`🌐 EVM Network: ${EVM_NETWORK}`);
console.log(`🌐 SVM Network: ${SVM_NETWORK}`);
console.log(`🌐 Aptos Network: ${APTOS_NETWORK}`);
console.log(`🌐 AVM Network: ${AVM_NETWORK}`);
console.log(`🌐 Stellar Network: ${STELLAR_NETWORK}`);
if (EVM_RPC_URL) console.log(`🌐 EVM RPC URL: ${EVM_RPC_URL}`);
if (SVM_RPC_URL) console.log(`🌐 SVM RPC URL: ${SVM_RPC_URL}`);
if (AVM_RPC_URL) console.log(`🌐 AVM RPC URL: ${AVM_RPC_URL}`);
if (APTOS_RPC_URL) console.log(`🌐 Aptos RPC URL: ${APTOS_RPC_URL}`);
if (STELLAR_RPC_URL) console.log(`🌐 Stellar RPC URL: ${STELLAR_RPC_URL}`);

// Validate required environment variables
if (!process.env.EVM_PRIVATE_KEY) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

if (!process.env.SVM_PRIVATE_KEY) {
  console.error("❌ SVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

// Initialize the EVM account from private key
const evmAccount = privateKeyToAccount(
  process.env.EVM_PRIVATE_KEY as `0x${string}`,
);
console.info(`EVM Facilitator account: ${evmAccount.address}`);

// Initialize the SVM account from private key
const svmAccount = await createKeyPairSignerFromBytes(
  base58.decode(process.env.SVM_PRIVATE_KEY as string),
);
console.info(`SVM Facilitator account: ${svmAccount.address}`);

// Initialize the Aptos account from private key (format to AIP-80 compliant format) if provided
let aptosAccount: Account | undefined;
if (process.env.APTOS_PRIVATE_KEY) {
  const formattedAptosKey = PrivateKey.formatPrivateKey(
    process.env.APTOS_PRIVATE_KEY as string,
    PrivateKeyVariants.Ed25519,
  );
  const aptosPrivateKey = new Ed25519PrivateKey(formattedAptosKey);
  aptosAccount = Account.fromPrivateKey({ privateKey: aptosPrivateKey });
  console.info(
    `Aptos Facilitator account: ${aptosAccount.accountAddress.toStringLong()}`,
  );
}

// Initialize the AVM signer from private key (optional)
let avmSigner: ReturnType<typeof toFacilitatorAvmSigner> | undefined;
if (process.env.AVM_PRIVATE_KEY) {
  avmSigner = toFacilitatorAvmSigner(process.env.AVM_PRIVATE_KEY as string);
  console.info(`AVM Facilitator account: ${avmSigner.getAddresses()[0]}`);
}

// Initialize the Stellar signer from private key (optional)
let stellarSigner: FacilitatorStellarSigner | undefined;
if (process.env.STELLAR_PRIVATE_KEY) {
  stellarSigner = createEd25519Signer(process.env.STELLAR_PRIVATE_KEY as string, STELLAR_NETWORK as Network);
  console.info(`Stellar Facilitator account: ${stellarSigner.address}`);
}

// Create a Viem client with both wallet and public capabilities
const evmChain = getEvmChain(EVM_NETWORK);
const viemClient = createWalletClient({
  account: evmAccount,
  chain: evmChain,
  transport: http(EVM_RPC_URL),
}).extend(publicActions);

// Initialize the x402 Facilitator with EVM, SVM, and Aptos support

const evmSigner = toFacilitatorEvmSigner({
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
  }) => viemClient.verifyTypedData(args as any),
  writeContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
    gas?: bigint;
  }) =>
    viemClient.writeContract({
      ...args,
      args: args.args || [],
      gas: args.gas,
    }),
  sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
    viemClient.sendTransaction(args),
  waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
    viemClient.waitForTransactionReceipt(args),
  getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
});

// Facilitator can now handle all Solana networks with automatic RPC creation
// Pass custom RPC URL if provided
const svmSigner = toFacilitatorSvmSigner(
  svmAccount,
  SVM_RPC_URL ? { defaultRpcUrl: SVM_RPC_URL } : undefined,
);

// Facilitator can handle all Aptos networks with automatic RPC creation
// Pass custom RPC URL if provided
const aptosSigner = aptosAccount
  ? toFacilitatorAptosSigner(
      aptosAccount,
      APTOS_RPC_URL ? { defaultRpcUrl: APTOS_RPC_URL } : undefined,
    )
  : undefined;

const verifiedPayments = new Map<string, number>();
const bazaarCatalog = new BazaarCatalog();

function createPaymentHash(paymentPayload: PaymentPayload): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(paymentPayload))
    .digest("hex");
}

const facilitator = new x402Facilitator();

// Register EVM, SVM, and Aptos schemes (v2 + v1)
facilitator
  .register(EVM_NETWORK as Network, new ExactEvmScheme(evmSigner))
  .register(EVM_NETWORK as Network, new UptoEvmScheme(evmSigner))
  .registerV1(EVM_V1_NETWORKS as Network[], new ExactEvmSchemeV1(evmSigner))
  .register(SVM_NETWORK as Network, new ExactSvmScheme(svmSigner))
  .registerV1(SVM_V1_NETWORKS as Network[], new ExactSvmSchemeV1(svmSigner));
if (avmSigner) {
  facilitator.register(
    AVM_NETWORK as Network,
    new ExactAvmScheme(avmSigner),
  );
}
if (aptosSigner) {
  facilitator.register(
    APTOS_NETWORK as Network,
    new ExactAptosScheme(aptosSigner),
  );
}
if (stellarSigner) {
  facilitator.register(STELLAR_NETWORK as Network, new ExactStellarScheme([stellarSigner]));
}

const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const erc20AllowanceAbi = [
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const erc20ApprovalSigner = {
  ...evmSigner,
  sendTransactions: async (
    transactions: (`0x${string}` | { to: `0x${string}`; data: `0x${string}`; gas?: bigint })[],
  ): Promise<`0x${string}`[]> => {
    const hashes: `0x${string}`[] = [];
    for (const tx of transactions) {
      let hash: `0x${string}`;
      if (typeof tx === "string") {
        // Parse the raw tx to extract sender and gas params for potential gas funding
        const parsed = parseTransaction(tx);
        const payerAddress = await recoverTransactionAddress({ serializedTransaction: tx });
        const gas = parsed.gas ?? 70_000n;
        const maxFeePerGas = parsed.maxFeePerGas ?? 1_000_000_000n;
        const gasCost = gas * maxFeePerGas;

        // Check if the payer has enough ETH for gas
        const payerBalance = await viemClient.getBalance({ address: payerAddress });
        if (payerBalance < gasCost) {
          const deficit = gasCost - payerBalance;
          console.log(`⛽ Funding payer ${payerAddress} with ${deficit} wei for gas`);
          const fundHash = await viemClient.sendTransaction({
            to: payerAddress,
            value: deficit,
          });
          const fundReceipt = await viemClient.waitForTransactionReceipt({ hash: fundHash });
          if (fundReceipt.status !== "success") {
            throw new Error(`gas_funding_failed: ${fundHash}`);
          }
          console.log(`⛽ Gas funding confirmed: ${fundHash}`);
        }

        hash = await viemClient.sendRawTransaction({ serializedTransaction: tx });
      } else {
        hash = await viemClient.sendTransaction(tx);
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
  .registerExtension(BAZAAR)
  .registerExtension(EIP2612_GAS_SPONSORING)
  .registerExtension(createErc20ApprovalGasSponsoringExtension(erc20ApprovalSigner))
  // Lifecycle hooks for payment tracking and discovery
  .onAfterVerify(async (context) => {
    // Hook 1: Track verified payment for verify→settle flow validation
    if (context.result.isValid) {
      const paymentHash = createPaymentHash(context.paymentPayload);
      verifiedPayments.set(paymentHash, Date.now());

      // Hook 2: Extract and catalog bazaar discovery info
      const discovered = extractDiscoveryInfo(
        context.paymentPayload,
        context.requirements,
      );
      if (discovered && "method" in discovered && discovered.method) {
        bazaarCatalog.catalogResource(
          discovered.resourceUrl,
          discovered.method,
          discovered.x402Version,
          discovered.discoveryInfo,
          context.requirements,
          discovered.routeTemplate,
        );
        console.log(
          `📦 Discovered resource: ${discovered.method} ${discovered.resourceUrl}`,
        );
      }
    }
  })
  .onBeforeSettle(async (context) => {
    // Hook 3: Validate payment was previously verified
    const paymentHash = createPaymentHash(context.paymentPayload);
    const verificationTimestamp = verifiedPayments.get(paymentHash);

    if (!verificationTimestamp) {
      return {
        abort: true,
        reason: "Payment must be verified before settlement",
      };
    }

    // Check verification isn't too old (5 minute timeout)
    const age = Date.now() - verificationTimestamp;
    if (age > 5 * 60 * 1000) {
      verifiedPayments.delete(paymentHash);
      return {
        abort: true,
        reason: "Payment verification expired (must settle within 5 minutes)",
      };
    }
  })
  .onAfterSettle(async (context) => {
    // Hook 4: Clean up verified payment tracking after settlement
    const paymentHash = createPaymentHash(context.paymentPayload);
    verifiedPayments.delete(paymentHash);

    if (context.result.success) {
      console.log(`✅ Settlement completed: ${context.result.transaction}`);
    }
  })
  .onSettleFailure(async (context) => {
    // Hook 5: Clean up on settlement failure too
    const paymentHash = createPaymentHash(context.paymentPayload);
    verifiedPayments.delete(paymentHash);

    console.error(`❌ Settlement failed: ${context.error.message}`);
  });

// Initialize Express app
const app = express();
app.use(express.json());

/**
 * POST /verify
 * Verify a payment against requirements
 *
 * Note: Payment tracking and bazaar discovery are handled by lifecycle hooks
 */
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

    // Hooks will automatically:
    // - Track verified payment (onAfterVerify)
    // - Extract and catalog discovery info (onAfterVerify)
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

/**
 * POST /settle
 * Settle a payment on-chain
 *
 * Note: Verification validation and cleanup are handled by lifecycle hooks
 */
app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    // Hooks will automatically:
    // - Validate payment was verified (onBeforeSettle - will abort if not)
    // - Check verification timeout (onBeforeSettle)
    // - Clean up tracking (onAfterSettle / onSettleFailure)
    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);

    // Check if this was an abort from hook
    if (
      error instanceof Error &&
      error.message.includes("Settlement aborted:")
    ) {
      // Return a proper SettleResponse instead of 500 error
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

/**
 * GET /supported
 * Get supported payment kinds and extensions
 */
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

app.get("/discovery/resources", (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;

    const response = bazaarCatalog.getResources(limit, offset);
    res.json(response);
  } catch (error) {
    console.error("Discovery resources error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    evmNetwork: EVM_NETWORK,
    svmNetwork: SVM_NETWORK,
    avmNetwork: avmSigner ? AVM_NETWORK : "(not configured)",
    aptosNetwork: aptosAccount ? APTOS_NETWORK : "(not configured)",
    stellarNetwork: stellarSigner ? STELLAR_NETWORK : "(not configured)",
    facilitator: "typescript",
    version: "2.0.0",
    extensions: [BAZAAR.key],
    discoveredResources: bazaarCatalog.getCount(),
  });
});

/**
 * POST /close
 * Graceful shutdown endpoint
 */
app.post("/close", (req, res) => {
  res.json({ message: "Facilitator shutting down gracefully" });
  console.log("Received shutdown request");

  // Give time for response to be sent
  setTimeout(() => {
    process.exit(0);
  }, 100);
});

// Start the server
app.listen(parseInt(PORT), () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║           x402 TypeScript Facilitator                  ║
╠════════════════════════════════════════════════════════╣
║  Server:       http://localhost:${PORT}                ║
║  EVM Network:  ${EVM_NETWORK}                          ║
║  SVM Network:  ${SVM_NETWORK}                          ║
║  AVM Network:  ${AVM_NETWORK}                          ║
║  Aptos Network: ${APTOS_NETWORK}                       ║
║  EVM Address:  ${evmAccount.address}                   ║
║  AVM Address:  ${avmSigner ? avmSigner.getAddresses()[0] : "(not configured)"}
║  Aptos Address: ${aptosAccount ? aptosAccount.accountAddress.toStringLong().slice(0, 20) + "..." : "(not configured)"}
║  Stellar Address: ${stellarSigner ? stellarSigner.address : "(not configured)"} ║
║  Extensions:   bazaar                                  ║
║                                                        ║
║  Endpoints:                                            ║
║  • POST /verify              (verify payment)          ║
║  • POST /settle              (settle payment)          ║
║  • GET  /supported           (get supported kinds)     ║
║  • GET  /discovery/resources (list discovered)         ║
║  • GET  /health              (health check)            ║
║  • POST /close               (shutdown server)         ║
╚════════════════════════════════════════════════════════╝
  `);

  // Log that facilitator is ready (needed for e2e test discovery)
  console.log("Facilitator listening");
});
