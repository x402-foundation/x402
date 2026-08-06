/**
 * All Networks Server Example
 *
 * Demonstrates how to create a server that supports all available networks with
 * optional chain configuration via environment variables.
 *
 * New chain support should be added here in alphabetic order by network prefix
 * (e.g., "algorand" before "aptos" before "ccd" before "eip155" before "hedera" before "near" before "solana" before "stellar" before "tvm" before "xrpl").
 */

import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { APTOS_TESTNET_CAIP2 } from "@x402/aptos";
import { ExactAptosScheme } from "@x402/aptos/exact/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { KEETA_TESTNET_CAIP2 } from "@x402/keeta";
import { ExactKeetaScheme } from "@x402/keeta/exact/server";
import { NEAR_TESTNET_CAIP2 } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { ExactTvmScheme } from "@x402/tvm/exact/server";
import { XRPL_TESTNET } from "@x402/xrpl";
import { ExactXrplScheme } from "@x402/xrpl/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network, Price } from "@x402/core/types";

config();

// Configuration - optional per network
const avmAddress = process.env.AVM_ADDRESS as string | undefined;
const aptosAddress = process.env.APTOS_ADDRESS as string | undefined;
const ccdAddress = process.env.CCD_ADDRESS as string | undefined;
const evmAddress = process.env.EVM_ADDRESS as `0x${string}` | undefined;
const hederaAddress = process.env.HEDERA_ACCOUNT_ID as string | undefined;
const keetaAddress = process.env.KEETA_ADDRESS as string | undefined;
const nearAddress = process.env.NEAR_ADDRESS as string | undefined;
const svmAddress = process.env.SVM_ADDRESS as string | undefined;
const stellarAddress = process.env.STELLAR_ADDRESS as string | undefined;
const tvmAddress = process.env.TVM_ADDRESS as string | undefined;
const xrplAddress = process.env.XRPL_ADDRESS as string | undefined;

// Validate at least one address is provided
if (
  !avmAddress &&
  !aptosAddress &&
  !ccdAddress &&
  !evmAddress &&
  !svmAddress &&
  !keetaAddress &&
  !nearAddress &&
  !stellarAddress &&
  !hederaAddress &&
  !tvmAddress &&
  !xrplAddress
) {
  console.error(
    "❌ At least one of AVM_ADDRESS, APTOS_ADDRESS, CCD_ADDRESS, EVM_ADDRESS, KEETA_ADDRESS, NEAR_ADDRESS, SVM_ADDRESS, STELLAR_ADDRESS, HEDERA_ACCOUNT_ID, TVM_ADDRESS, or XRPL_ADDRESS is required",
  );
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}

// Network configuration
const AVM_NETWORK = (process.env.AVM_NETWORK || ALGORAND_TESTNET_CAIP2) as Network; // Algorand Testnet
const APTOS_NETWORK = (process.env.APTOS_NETWORK || APTOS_TESTNET_CAIP2) as Network; // Aptos Testnet
const CCD_NETWORK = "ccd:4221332d34e1694168c2a0c0b3fd0f27" as const; // Concordium Testnet
const EVM_NETWORK = "eip155:84532" as const; // Base Sepolia
const HEDERA_NETWORK = "hedera:testnet" as const; // Hedera Testnet
const KEETA_NETWORK = KEETA_TESTNET_CAIP2; // Keeta Testnet
const NEAR_NETWORK = (process.env.NEAR_NETWORK || NEAR_TESTNET_CAIP2) as Network; // NEAR Testnet
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const; // Solana Devnet
const STELLAR_NETWORK = "stellar:testnet" as const; // Stellar Testnet
const HEDERA_HBAR_ASSET = "0.0.0" as const; // Native HBAR asset id
const HEDERA_WEATHER_PRICE_TINYBARS = "100000" as const; // 0.001 HBAR
const TVM_NETWORK = (process.env.TVM_NETWORK || "tvm:-3") as Network; // TON Testnet
const XRPL_NETWORK = (process.env.XRPL_NETWORK || XRPL_TESTNET) as Network; // XRPL Testnet
const CCD_WEATHER_PRICE_MICRO_CCD = "1000" as const; // 0.001 CCD

// Build accepts array dynamically based on configured addresses
const accepts: Array<{
  scheme: string;
  price: Price;
  network: Network;
  payTo: string;
}> = [];
if (avmAddress) {
  accepts.push({
    scheme: "exact",
    price: "$0.001",
    network: AVM_NETWORK,
    payTo: avmAddress,
  });
}
if (aptosAddress) {
  accepts.push({
    scheme: "exact",
    price: "$0.001",
    network: APTOS_NETWORK,
    payTo: aptosAddress,
  });
}
if (ccdAddress) {
  accepts.push({
    scheme: "exact",
    price: {
      amount: CCD_WEATHER_PRICE_MICRO_CCD,
      asset: "CCD",
    },
    network: CCD_NETWORK,
    payTo: ccdAddress,
  });
}
if (evmAddress) {
  accepts.push({
    scheme: "exact",
    price: "$0.001",
    network: EVM_NETWORK,
    payTo: evmAddress,
  });
}
if (hederaAddress) {
  accepts.push({
    scheme: "exact",
    price: {
      amount: HEDERA_WEATHER_PRICE_TINYBARS,
      asset: HEDERA_HBAR_ASSET,
    },
    network: HEDERA_NETWORK,
    payTo: hederaAddress,
  });
}
if (keetaAddress) {
  accepts.push({
    scheme: "exact",
    price: "$0.001",
    network: KEETA_NETWORK,
    payTo: keetaAddress,
  });
}
if (nearAddress) {
  accepts.push({
    scheme: "exact",
    price: "$0.001",
    network: NEAR_NETWORK,
    payTo: nearAddress,
  });
}
if (svmAddress) {
  accepts.push({
    scheme: "exact",
    price: "$0.001",
    network: SVM_NETWORK,
    payTo: svmAddress,
  });
}
if (stellarAddress) {
  accepts.push({
    scheme: "exact",
    price: "$0.001",
    network: STELLAR_NETWORK,
    payTo: stellarAddress,
  });
}
if (tvmAddress) {
  accepts.push({
    scheme: "exact",
    price: "$0.001",
    network: TVM_NETWORK,
    payTo: tvmAddress,
  });
}
if (xrplAddress) {
  accepts.push({
    scheme: "exact",
    price: {
      amount: process.env.XRPL_AMOUNT || "1000",
      asset: "XRP",
    },
    network: XRPL_NETWORK,
    payTo: xrplAddress,
  });
}

// Create facilitator client
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// Create x402 resource server and register schemes dynamically
const server = new x402ResourceServer(facilitatorClient);
if (avmAddress) {
  server.register(AVM_NETWORK, new ExactAvmScheme());
}
if (aptosAddress) {
  server.register(APTOS_NETWORK, new ExactAptosScheme());
}
if (ccdAddress) {
  server.register(CCD_NETWORK, new ExactConcordiumScheme());
}
if (evmAddress) {
  server.register(EVM_NETWORK, new ExactEvmScheme());
}
if (hederaAddress) {
  server.register(HEDERA_NETWORK, new ExactHederaScheme());
}
if (keetaAddress) {
  server.register(KEETA_NETWORK, new ExactKeetaScheme());
}
if (nearAddress) {
  server.register(NEAR_NETWORK, new ExactNearScheme());
}
if (svmAddress) {
  server.register(SVM_NETWORK, new ExactSvmScheme());
}
if (stellarAddress) {
  server.register(STELLAR_NETWORK, new ExactStellarScheme());
}
if (tvmAddress) {
  server.register(TVM_NETWORK, new ExactTvmScheme());
}
if (xrplAddress) {
  server.register(XRPL_NETWORK, new ExactXrplScheme());
}

// Create Express app
const app = express();

// Apply payment middleware
app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts,
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    server,
  ),
);

// Protected endpoint
app.get("/weather", (req, res) => {
  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

// Health check (no payment required)
app.get("/health", (req, res) => {
  res.send({ status: "ok" });
});

// Start server
const port = process.env.PORT || 4021;
app.listen(port, () => {
  console.log(`🚀 All Networks Server listening at http://localhost:${port}`);
  if (avmAddress) {
    console.log(`   AVM: ${avmAddress} on ${AVM_NETWORK}`);
  }
  if (aptosAddress) {
    console.log(`   Aptos: ${aptosAddress} on ${APTOS_NETWORK}`);
  }
  if (ccdAddress) {
    console.log(`   CCD: ${ccdAddress} on ${CCD_NETWORK}`);
  }
  if (evmAddress) {
    console.log(`   EVM: ${evmAddress} on ${EVM_NETWORK}`);
  }
  if (hederaAddress) {
    console.log(`   Hedera: ${hederaAddress} on ${HEDERA_NETWORK}`);
  }
  if (keetaAddress) {
    console.log(`   Keeta: ${keetaAddress} on ${KEETA_NETWORK}`);
  }
  if (nearAddress) {
    console.log(`   NEAR: ${nearAddress} on ${NEAR_NETWORK}`);
  }
  if (svmAddress) {
    console.log(`   SVM: ${svmAddress} on ${SVM_NETWORK}`);
  }
  if (stellarAddress) {
    console.log(`   Stellar: ${stellarAddress} on ${STELLAR_NETWORK}`);
  }
  if (tvmAddress) {
    console.log(`   TVM: ${tvmAddress} on ${TVM_NETWORK}`);
  }
  if (xrplAddress) {
    console.log(`   XRPL: ${xrplAddress} on ${XRPL_NETWORK}`);
  }
  console.log(`   Facilitator: ${facilitatorUrl}`);
  console.log();
});
