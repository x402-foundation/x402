/**
 * All Networks Facilitator Example
 *
 * Demonstrates how to create a facilitator that supports all available networks with
 * optional chain configuration via environment variables.
 *
 * New chain support should be added here in alphabetic order by network prefix
 * (e.g., "eip155" before "solana" before "stellar").
 */

import * as KeetaNet from "@keetanetwork/keetanet-client";
import { toFacilitatorAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/facilitator";
import { ExactConcordiumScheme } from "@x402/concordium/exact/facilitator";
import {
  CONCORDIUM_TESTNET_CAIP2,
  getConcordiumGrpcUrl,
  parseGrpcUrl,
  toConcordiumFacilitatorSigner,
} from "@x402/concordium";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  Network,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { UptoEvmScheme } from "@x402/evm/upto/facilitator";
import {
  AccountId,
  Client,
  PrivateKey,
  createHederaClient,
  createHederaPreflightTransfer,
  createHederaSignAndSubmitTransaction,
  toFacilitatorHederaSigner,
} from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/facilitator";
import {
  toFacilitatorKeetaSigner,
  KEETA_TESTNET_CAIP2,
  FacilitatorKeetaSigner,
} from "@x402/keeta";
import { ExactKeetaScheme } from "@x402/keeta/exact/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import {
  HighloadV3Config,
  toFacilitatorTvmSigner,
  TVM_PROVIDER_TONAPI,
  TVM_PROVIDER_TONCENTER,
} from "@x402/tvm";
import { ExactTvmScheme } from "@x402/tvm/exact/facilitator";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

dotenv.config();

// Configuration
const PORT = process.env.PORT || "4022";

// Configuration - optional per network (alphabetic order)
const avmPrivateKey = process.env.AVM_PRIVATE_KEY as string | undefined;
const ccdFacilitatorPrivateKey = process.env.CCD_FACILITATOR_PRIVATE_KEY as
  | string
  | undefined;
const ccdFacilitatorAddress = process.env.CCD_FACILITATOR_ADDRESS as
  | string
  | undefined;
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const keetaMnemonic = process.env.KEETA_MNEMONIC as string | undefined;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string | undefined;
const stellarPrivateKey = process.env.STELLAR_PRIVATE_KEY as string | undefined;
const tvmPrivateKey = process.env.TVM_PRIVATE_KEY as string | undefined;
const hederaAccountId = process.env.HEDERA_ACCOUNT_ID;
// Hedera private key should be an ECDSA key string (0x-prefixed or DER-encoded).
const hederaPrivateKey = process.env.HEDERA_PRIVATE_KEY;

// Validate at least one private key is provided
if (
  !avmPrivateKey &&
  !(ccdFacilitatorPrivateKey && ccdFacilitatorAddress) &&
  !evmPrivateKey &&
  !keetaMnemonic &&
  !svmPrivateKey &&
  !stellarPrivateKey &&
  !tvmPrivateKey &&
  !(hederaAccountId && hederaPrivateKey)
) {
  console.error(
    "❌ At least one of AVM_PRIVATE_KEY, CCD_FACILITATOR_PRIVATE_KEY + CCD_FACILITATOR_ADDRESS, EVM_PRIVATE_KEY, KEETA_MNEMONIC, SVM_PRIVATE_KEY, STELLAR_PRIVATE_KEY, TVM_PRIVATE_KEY, or HEDERA_ACCOUNT_ID + HEDERA_PRIVATE_KEY is required",
  );
  process.exit(1);
}

// Network configuration (alphabetic order)
const AVM_NETWORK = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI="; // Algorand Testnet
const CCD_NETWORK = "ccd:4221332d34e1694168c2a0c0b3fd0f27"; // Concordium Testnet
const EVM_NETWORK = "eip155:84532"; // Base Sepolia
const HEDERA_NETWORK = "hedera:testnet"; // Hedera Testnet
const KEETA_NETWORK = KEETA_TESTNET_CAIP2; // Keeta Testnet
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // Solana Devnet
const STELLAR_NETWORK = "stellar:testnet"; // Stellar Testnet
const TVM_NETWORK = (process.env.TVM_NETWORK || "tvm:-3") as Network; // TON Testnet

// Initialize the x402 Facilitator
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

// Register AVM scheme if private key is provided
if (avmPrivateKey) {
  const avmSigner = toFacilitatorAvmSigner(avmPrivateKey);
  console.info(`AVM Facilitator account: ${avmSigner.getAddresses()[0]}`);
  facilitator.register(AVM_NETWORK, new ExactAvmScheme(avmSigner));
}

// Register Concordium scheme if private key + address are provided (recommended).
// This matches how every other mechanism reads a private key from an env var.
if (ccdFacilitatorPrivateKey && ccdFacilitatorAddress) {
  const [host, port] = parseGrpcUrl(getConcordiumGrpcUrl(CCD_NETWORK));

  const signer = toConcordiumFacilitatorSigner(
    ccdFacilitatorAddress,
    ccdFacilitatorPrivateKey,
    { host, port, useTls: true },
  );

  facilitator.register(CCD_NETWORK, new ExactConcordiumScheme({ signer }));
  console.info(
    `CCD Facilitator account: ${ccdFacilitatorAddress} on ${CCD_NETWORK}`,
  );
}

// Register EVM scheme if private key is provided
if (evmPrivateKey) {
  const evmAccount = privateKeyToAccount(evmPrivateKey);
  console.info(`EVM Facilitator account: ${evmAccount.address}`);

  // Create a Viem client with both wallet and public capabilities
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

  facilitator.register(
    EVM_NETWORK,
    new ExactEvmScheme(evmSigner, {
      // Add trusted ERC-6492 factory addresses here (e.g. your chosen ERC-4337 smart wallet factory).
      // A non-empty array enables smart wallet deployment; an empty array denies all factory calls.
      eip6492AllowedFactories: [],
    }),
  );
  facilitator.register(EVM_NETWORK, new UptoEvmScheme(evmSigner));
}

// Register Hedera scheme if account and private key are provided
if (hederaAccountId && hederaPrivateKey) {
  const hederaKey = PrivateKey.fromStringECDSA(hederaPrivateKey);
  const buildHederaClient = (network: string): Client => {
    const client = createHederaClient(network);
    client.setOperator(AccountId.fromString(hederaAccountId), hederaKey);
    return client;
  };

  const hederaSigner = toFacilitatorHederaSigner({
    getAddresses: () => [hederaAccountId],
    signAndSubmitTransaction: createHederaSignAndSubmitTransaction(
      buildHederaClient,
      hederaKey,
    ),
    preflightTransfer: createHederaPreflightTransfer(buildHederaClient),
  });
  facilitator.register(HEDERA_NETWORK, new ExactHederaScheme(hederaSigner));
  console.info(`Hedera Facilitator account: ${hederaAccountId}`);
}

// Register Keeta scheme if mnemonic is provided
let keetaSigner: FacilitatorKeetaSigner | undefined;
if (keetaMnemonic) {
  const keetaAccount = KeetaNet.lib.Account.fromSeed(
    await KeetaNet.lib.Account.seedFromPassphrase(keetaMnemonic),
    0,
  );
  console.info(
    `Keeta Facilitator account: ${keetaAccount.publicKeyString.toString()}`,
  );

  keetaSigner = toFacilitatorKeetaSigner([keetaAccount]);
  facilitator.register(
    KEETA_NETWORK,
    new ExactKeetaScheme(keetaSigner, console),
  );
}

// Register SVM scheme if private key is provided
if (svmPrivateKey) {
  const svmAccount = await createKeyPairSignerFromBytes(
    base58.decode(svmPrivateKey),
  );
  console.info(`SVM Facilitator account: ${svmAccount.address}`);

  const svmSigner = toFacilitatorSvmSigner(svmAccount);

  facilitator.register(SVM_NETWORK, new ExactSvmScheme(svmSigner));
}

// Register Stellar scheme if private key is provided
if (stellarPrivateKey) {
  const stellarSigner = createEd25519Signer(stellarPrivateKey);
  console.info(`Stellar Facilitator account: ${stellarSigner.address}`);

  facilitator.register(
    STELLAR_NETWORK,
    new ExactStellarScheme([stellarSigner]),
  );
}

// Register TVM scheme if private key is provided
if (tvmPrivateKey) {
  const tvmProvider = (
    process.env.TVM_PROVIDER || TVM_PROVIDER_TONCENTER
  ).toLowerCase();
  const tvmConfig = HighloadV3Config.fromPrivateKey(tvmPrivateKey, {
    provider: tvmProvider,
    apiKey:
      tvmProvider === TVM_PROVIDER_TONAPI
        ? process.env.TONAPI_API_KEY
        : process.env.TONCENTER_API_KEY,
    providerBaseUrl:
      tvmProvider === TVM_PROVIDER_TONAPI
        ? process.env.TONAPI_BASE_URL
        : process.env.TONCENTER_BASE_URL,
  });
  const tvmSigner = toFacilitatorTvmSigner({ [TVM_NETWORK]: tvmConfig });
  console.info(
    `TVM Facilitator account: ${tvmSigner.getAddressesForNetwork(TVM_NETWORK)[0]}`,
  );

  facilitator.register(TVM_NETWORK, new ExactTvmScheme(tvmSigner));
}

// Initialize Express app
const app = express();
app.use(express.json());

/**
 * POST /verify
 * Verify a payment against requirements
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
 */
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

    // Check if this was an abort from hook
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

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Start the server
let server = app.listen(parseInt(PORT), () => {
  console.log(
    `🚀 All Networks Facilitator listening on http://localhost:${PORT}`,
  );
  console.log(
    `   Supported networks: ${facilitator
      .getSupported()
      .kinds.map((k) => k.network)
      .join(", ")}`,
  );
  console.log();
});

if (keetaSigner) {
  const shutdown = async () => {
    server.close(async () => {
      await keetaSigner.destroy();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
