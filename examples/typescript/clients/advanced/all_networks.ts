/**
 * All Networks Client Example
 *
 * Demonstrates how to create a client that supports all available networks with
 * optional chain configuration via environment variables.
 *
 * New chain support should be added here in alphabetic order by network prefix
 * (e.g., "algorand" before "eip155" before "solana").
 */

import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { privateKeyToAccount } from "viem/accounts";

config();

// Configuration - optional per network
const avmPrivateKey = process.env.AVM_PRIVATE_KEY as string | undefined;
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string | undefined;
const stellarPrivateKey = process.env.STELLAR_PRIVATE_KEY as string | undefined;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;

/**
 * Example demonstrating how to use @x402/fetch with all supported networks.
 * Schemes are registered directly for networks where private keys are provided.
 */
async function main(): Promise<void> {
  // Validate at least one private key is provided
  if (!avmPrivateKey && !evmPrivateKey && !svmPrivateKey && !stellarPrivateKey) {
    console.error(
      "❌ At least one of AVM_PRIVATE_KEY, EVM_PRIVATE_KEY, SVM_PRIVATE_KEY, or STELLAR_PRIVATE_KEY is required",
    );
    process.exit(1);
  }

  // Create x402 client
  const client = new x402Client();

  // Register AVM scheme if private key is provided
  if (avmPrivateKey) {
    const avmSigner = toClientAvmSigner(avmPrivateKey);
    client.register("algorand:*", new ExactAvmScheme(avmSigner));
    console.log(`Initialized AVM account: ${avmSigner.address}`);
  }

  // Register EVM scheme if private key is provided
  if (evmPrivateKey) {
    const evmSigner = privateKeyToAccount(evmPrivateKey);
    client.register("eip155:*", new ExactEvmScheme(evmSigner));
    client.register("eip155:*", new UptoEvmScheme(evmSigner));
    console.log(`Initialized EVM account: ${evmSigner.address}`);
  }

  // Register SVM scheme if private key is provided
  if (svmPrivateKey) {
    const svmSigner = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey));
    client.register("solana:*", new ExactSvmScheme(svmSigner));
    console.log(`Initialized SVM account: ${svmSigner.address}`);
  }

  // Register Stellar scheme if private key is provided
  if (stellarPrivateKey) {
    const stellarSigner = createEd25519Signer(stellarPrivateKey);
    client.register("stellar:*", new ExactStellarScheme(stellarSigner));
    console.log(`Initialized Stellar account: ${stellarSigner.address}`);
  }

  // Wrap fetch with payment handling
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log(`\nMaking request to: ${url}\n`);

  // Make the request
  const response = await fetchWithPayment(url, { method: "GET" });
  const body = await response.json();
  console.log("Response body:", body);

  const paymentResponse = new x402HTTPClient(client).getPaymentSettleResponse(name =>
    response.headers.get(name),
  );
  console.log("\nPayment response:", JSON.stringify(paymentResponse, null, 2));
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
