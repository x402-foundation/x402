/**
 * All Networks Client Example
 *
 * Demonstrates how to create a client that supports all available networks with
 * optional chain configuration via environment variables.
 *
 * New chain support should be added here in alphabetic order by network prefix
 * (e.g., "algorand" before "aptos" before "ccd" before "eip155" before "hedera" before "near" before "solana" before "stellar" before "tvm" before "xrpl").
 */

import {
  Account,
  Ed25519PrivateKey,
  PrivateKey as AptosPrivateKey,
  PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";
import { config } from "dotenv";
import type { Network } from "@x402/core/types";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactAptosScheme } from "@x402/aptos/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { toClientKeetaSigner } from "@x402/keeta";
import { ExactKeetaScheme } from "@x402/keeta/exact/client";
import {
  createClientNearSigner,
  NEAR_TESTNET_CAIP2,
  type ClientNearSignerConfig,
} from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/client";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { ExactTvmScheme } from "@x402/tvm/exact/client";
import { createEd25519Signer } from "@x402/stellar";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { toClientTvmSigner, TVM_PROVIDER_TONAPI, TVM_PROVIDER_TONCENTER } from "@x402/tvm";
import { keyPairFromSeed, type KeyPair } from "@ton/crypto";
import { createXrplWalletSigner, XRPL_TESTNET } from "@x402/xrpl";
import { ExactXrplScheme } from "@x402/xrpl/exact/client";
import { Wallet } from "xrpl";
import { buildBasicAccountSigner, AccountAddress } from "@concordium/web-sdk";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { privateKeyToAccount } from "viem/accounts";
import * as KeetaNet from "@keetanetwork/keetanet-client";

config();

// Configuration - optional per network
const avmPrivateKey = process.env.AVM_PRIVATE_KEY as string | undefined;
const aptosPrivateKey = process.env.APTOS_PRIVATE_KEY as string | undefined;
const ccdPrivateKey = process.env.CCD_PRIVATE_KEY as string | undefined;
const ccdAddress = process.env.CCD_ADDRESS as string | undefined;
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const keetaMnemonic = process.env.KEETA_MNEMONIC as string | undefined;
const nearAccountId = process.env.NEAR_ACCOUNT_ID as string | undefined;
const nearPrivateKey = process.env.NEAR_PRIVATE_KEY as
  | ClientNearSignerConfig["secretKey"]
  | undefined;
const nearNetwork = (process.env.NEAR_NETWORK || NEAR_TESTNET_CAIP2) as Network;
const nearRpcUrl = process.env.NEAR_RPC_URL as string | undefined;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string | undefined;
const stellarPrivateKey = process.env.STELLAR_PRIVATE_KEY as string | undefined;
const hederaAccountId = process.env.HEDERA_ACCOUNT_ID;
// Hedera private key should be an ECDSA key string (0x-prefixed or DER-encoded).
const hederaPrivateKey = process.env.HEDERA_PRIVATE_KEY;
const hederaNetwork = process.env.HEDERA_NETWORK || "hedera:testnet";
const tvmPrivateKey = process.env.TVM_PRIVATE_KEY as string | undefined;
const tvmNetwork = process.env.TVM_NETWORK || "tvm:-3";
const tvmProvider = (process.env.TVM_PROVIDER || TVM_PROVIDER_TONCENTER).toLowerCase();
const xrplSeed = process.env.XRPL_SEED as string | undefined;
const xrplNetwork = (process.env.XRPL_NETWORK || XRPL_TESTNET) as Network;
const xrplWsUrl = process.env.XRPL_WS_URL as string | undefined;
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
    !aptosPrivateKey &&
    !(ccdPrivateKey && ccdAddress) &&
    !evmPrivateKey &&
    !keetaMnemonic &&
    !(nearAccountId && nearPrivateKey) &&
    !svmPrivateKey &&
    !stellarPrivateKey &&
    !(hederaAccountId && hederaPrivateKey) &&
    !tvmPrivateKey &&
    !xrplSeed
  ) {
    console.error(
      "❌ At least one of AVM_PRIVATE_KEY, APTOS_PRIVATE_KEY, CCD_PRIVATE_KEY + CCD_ADDRESS, EVM_PRIVATE_KEY, KEETA_MNEMONIC, NEAR_ACCOUNT_ID + NEAR_PRIVATE_KEY, SVM_PRIVATE_KEY, STELLAR_PRIVATE_KEY, HEDERA_ACCOUNT_ID + HEDERA_PRIVATE_KEY, TVM_PRIVATE_KEY, or XRPL_SEED is required",
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

  // Register Aptos scheme if private key is provided
  if (aptosPrivateKey) {
    const formattedKey = AptosPrivateKey.formatPrivateKey(
      aptosPrivateKey,
      PrivateKeyVariants.Ed25519,
    );
    const account = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(formattedKey) });
    client.register("aptos:*", new ExactAptosScheme(account));
    console.log(`Initialized Aptos account: ${account.accountAddress.toStringLong()}`);
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

  // Register NEAR scheme if account and private key are provided
  if (nearAccountId && nearPrivateKey) {
    const nearSigner = createClientNearSigner({
      accountId: nearAccountId,
      secretKey: nearPrivateKey,
      rpcUrls: nearRpcUrl ? { [nearNetwork]: nearRpcUrl } : undefined,
    });
    client.register(nearNetwork, new ExactNearScheme(nearSigner));
    console.log(`Initialized NEAR account: ${nearAccountId} on ${nearNetwork}`);
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

  // Register XRPL scheme if seed is provided
  if (xrplSeed) {
    const xrplSigner = createXrplWalletSigner(Wallet.fromSeed(xrplSeed));
    client.register(
      xrplNetwork,
      new ExactXrplScheme(
        xrplSigner,
        xrplWsUrl ? { wsUrlByNetwork: { [xrplNetwork as `xrpl:${number}`]: xrplWsUrl } } : {},
      ),
    );
    console.log(`Initialized XRPL account: ${xrplSigner.classicAddress} on ${xrplNetwork}`);
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
