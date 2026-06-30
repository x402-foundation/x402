/**
 * All Networks Client Example
 *
 * Demonstrates how to create a client that supports all available networks with
 * optional chain configuration via environment variables.
 *
 * New chain support should be added here in alphabetic order by network prefix
 * (e.g., "algorand" before "eip155" before "hedera" before "solana" before "stellar" before "tvm").
 */

import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { toClientKeetaSigner } from "@x402/keeta";
import { ExactKeetaScheme } from "@x402/keeta/exact/client";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { ExactTvmScheme } from "@x402/tvm/exact/client";
import { createEd25519Signer } from "@x402/stellar";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { toClientTvmSigner, TVM_PROVIDER_TONAPI, TVM_PROVIDER_TONCENTER } from "@x402/tvm";
import { keyPairFromSeed, type KeyPair } from "@ton/crypto";
import { buildBasicAccountSigner, AccountAddress } from "@concordium/web-sdk";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { privateKeyToAccount } from "viem/accounts";
import * as KeetaNet from "@keetanetwork/keetanet-client";

config();

// Configuration - optional per network
const avmPrivateKey = process.env.AVM_PRIVATE_KEY as string | undefined;
const ccdPrivateKey = process.env.CCD_PRIVATE_KEY as string | undefined;
const ccdAddress = process.env.CCD_ADDRESS as string | undefined;
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const keetaMnemonic = process.env.KEETA_MNEMONIC as string | undefined;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string | undefined;
const stellarPrivateKey = process.env.STELLAR_PRIVATE_KEY as string | undefined;
const hederaAccountId = process.env.HEDERA_ACCOUNT_ID;
// Hedera private key should be an ECDSA key string (0x-prefixed or DER-encoded).
const hederaPrivateKey = process.env.HEDERA_PRIVATE_KEY;
const hederaNetwork = process.env.HEDERA_NETWORK || "hedera:testnet";
const tvmPrivateKey = process.env.TVM_PRIVATE_KEY as string | undefined;
const tvmNetwork = process.env.TVM_NETWORK || "tvm:-3";
const tvmProvider = (process.env.TVM_PROVIDER || TVM_PROVIDER_TONCENTER).toLowerCase();
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;

/**
 * Parses a TVM private key seed or secret key from a hex/base64 environment value.
 *
 * @param privateKey - The TVM_PRIVATE_KEY environment value.
 * @returns A TON key pair derived from the seed component.
 */
function parseTvmKeyPair(privateKey: string): KeyPair {
  const value = privateKey.trim().replace(/^0x/, "");
  let bytes: Buffer;
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    bytes = Buffer.from(value, "hex");
  } else {
    bytes = Buffer.from(value, "base64");
  }
  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new Error("TVM_PRIVATE_KEY must be a 32-byte seed or 64-byte secret key");
  }
  return keyPairFromSeed(bytes.subarray(0, 32));
}

/**
 * Example demonstrating how to use @x402/fetch with all supported networks.
 * Schemes are registered directly for networks where private keys are provided.
 */
async function main(): Promise<void> {
  // Validate at least one private key is provided
  if (
    !avmPrivateKey &&
    !(ccdPrivateKey && ccdAddress) &&
    !evmPrivateKey &&
    !keetaMnemonic &&
    !svmPrivateKey &&
    !stellarPrivateKey &&
    !(hederaAccountId && hederaPrivateKey) &&
    !tvmPrivateKey
  ) {
    console.error(
      "❌ At least one of AVM_PRIVATE_KEY, CCD_PRIVATE_KEY + CCD_ADDRESS, EVM_PRIVATE_KEY, KEETA_MNEMONIC, SVM_PRIVATE_KEY, STELLAR_PRIVATE_KEY, HEDERA_ACCOUNT_ID + HEDERA_PRIVATE_KEY, or TVM_PRIVATE_KEY is required",
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

  // Register Concordium scheme if private key and address are provided
  if (ccdPrivateKey && ccdAddress) {
    const signer = {
      accountAddress: AccountAddress.fromBase58(ccdAddress),
      signer: buildBasicAccountSigner(ccdPrivateKey),
    };
    client.register("ccd:*", new ExactConcordiumScheme(signer));
    console.log(`Initialized CCD account: ${ccdAddress}`);
  }

  // Register EVM scheme if private key is provided
  if (evmPrivateKey) {
    const evmSigner = privateKeyToAccount(evmPrivateKey);
    client.register("eip155:*", new ExactEvmScheme(evmSigner));
    client.register("eip155:*", new UptoEvmScheme(evmSigner));
    console.log(`Initialized EVM account: ${evmSigner.address}`);
  }

  // Register Hedera scheme if private key is provided
  if (hederaAccountId && hederaPrivateKey) {
    const hederaSigner = createClientHederaSigner(
      hederaAccountId,
      PrivateKey.fromStringECDSA(hederaPrivateKey),
      { network: hederaNetwork },
    );
    client.register("hedera:*", new ExactHederaScheme(hederaSigner));
    console.log(`Initialized Hedera account: ${hederaAccountId} on ${hederaNetwork}`);
  }

  // Register Keeta scheme if mnemonic is provided
  const keetaAccount = keetaMnemonic
    ? KeetaNet.lib.Account.fromSeed(await KeetaNet.lib.Account.seedFromPassphrase(keetaMnemonic), 0)
    : null;
  await using keetaSigner = keetaAccount ? toClientKeetaSigner(keetaAccount) : null;
  if (keetaSigner && keetaAccount) {
    client.register("keeta:*", new ExactKeetaScheme(keetaSigner));
    console.log(`Initialized Keeta account: ${keetaAccount.publicKeyString.toString()}`);
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

  // Register TVM scheme if private key is provided
  if (tvmPrivateKey) {
    const tvmSigner = toClientTvmSigner(parseTvmKeyPair(tvmPrivateKey), {
      network: tvmNetwork,
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
    client.register("tvm:*", new ExactTvmScheme(tvmSigner));
    console.log(`Initialized TVM account: ${tvmSigner.address}`);
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
