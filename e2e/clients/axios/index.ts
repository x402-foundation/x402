import { config } from "dotenv";
import axios from "axios";
import { wrapAxiosWithPayment, decodePaymentResponseHeader } from "@x402/axios";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { ExactEvmScheme, type ExactEvmSchemeOptions } from "@x402/evm/exact/client";
import { UptoEvmScheme as UptoEvmClientScheme, type UptoEvmSchemeOptions } from "@x402/evm/upto/client";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { toClientEvmSigner } from "@x402/evm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { ExactSvmSchemeV1 } from "@x402/svm/v1";
import { ExactAptosScheme } from "@x402/aptos/exact/client";
import { Account, Ed25519PrivateKey, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer, type Ed25519Signer } from "@x402/stellar";
import { ExactAvmScheme as ExactAvmClientScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client } from "@x402/core/client";

config();

const baseURL = process.env.RESOURCE_SERVER_URL as string;
const endpointPath = process.env.ENDPOINT_PATH as string;
const url = `${baseURL}${endpointPath}`;
const evmAccount = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const svmSigner = await createKeyPairSignerFromBytes(
  base58.decode(process.env.SVM_PRIVATE_KEY as string),
);

const evmNetwork = process.env.EVM_NETWORK || "eip155:84532";
const evmRpcUrl = process.env.EVM_RPC_URL;
const evmChain = evmNetwork === "eip155:8453" ? base : baseSepolia;

const publicClient = createPublicClient({
  chain: evmChain,
  transport: http(evmRpcUrl),
});

const evmSigner = toClientEvmSigner(evmAccount, publicClient);

const evmSchemeOptions: ExactEvmSchemeOptions | undefined = process.env.EVM_RPC_URL
  ? { rpcUrl: process.env.EVM_RPC_URL }
  : undefined;

const uptoSchemeOptions: UptoEvmSchemeOptions | undefined = process.env.EVM_RPC_URL
  ? { rpcUrl: process.env.EVM_RPC_URL }
  : undefined;

// Initialize Aptos signer if key is provided
let aptosAccount: Account | undefined;
if (process.env.APTOS_PRIVATE_KEY) {
  const formattedKey = PrivateKey.formatPrivateKey(
    process.env.APTOS_PRIVATE_KEY,
    PrivateKeyVariants.Ed25519,
  );
  const aptosPrivateKey = new Ed25519PrivateKey(formattedKey);
  aptosAccount = Account.fromPrivateKey({ privateKey: aptosPrivateKey });
}

// Initialize Stellar signer if key is provided
let stellarSigner: Ed25519Signer | undefined;
if (process.env.STELLAR_PRIVATE_KEY) {
  stellarSigner = createEd25519Signer(process.env.STELLAR_PRIVATE_KEY);
}

// Initialize AVM signer if key is provided
let avmSigner: ReturnType<typeof toClientAvmSigner> | undefined;
if (process.env.AVM_PRIVATE_KEY) {
  avmSigner = toClientAvmSigner(process.env.AVM_PRIVATE_KEY);
}

const client = new x402Client()
  .register("eip155:*", new ExactEvmScheme(evmSigner, evmSchemeOptions))
  .register("eip155:*", new UptoEvmClientScheme(evmSigner, uptoSchemeOptions))
  .registerV1("base-sepolia", new ExactEvmSchemeV1(evmSigner))
  .registerV1("base", new ExactEvmSchemeV1(evmSigner))
  .register("solana:*", new ExactSvmScheme(svmSigner))
  .registerV1("solana-devnet", new ExactSvmSchemeV1(svmSigner))
  .registerV1("solana", new ExactSvmSchemeV1(svmSigner));
if (aptosAccount) {
  client.register("aptos:*", new ExactAptosScheme(aptosAccount));
}
if (stellarSigner) {
  client.register("stellar:*", new ExactStellarScheme(stellarSigner));
}
if (avmSigner) {
  client.register("algorand:*", new ExactAvmClientScheme(avmSigner));
}

const axiosWithPayment = wrapAxiosWithPayment(axios.create(), client);

axiosWithPayment
  .get(url)
  .then(async (response) => {
    const data = response.data;
    // Check both v2 (PAYMENT-RESPONSE) and v1 (X-PAYMENT-RESPONSE) headers
    const paymentResponse =
      response.headers["payment-response"] || response.headers["x-payment-response"];

    if (!paymentResponse) {
      // No payment was required
      const result = {
        success: true,
        data: data,
        status_code: response.status,
      };
      console.log(JSON.stringify(result));
      process.exit(0);
      return;
    }

    const decodedPaymentResponse = decodePaymentResponseHeader(paymentResponse);

    const result = {
      success: decodedPaymentResponse.success,
      data: data,
      status_code: response.status,
      payment_response: decodedPaymentResponse,
    };

    // Output structured result as JSON for proxy to parse
    console.log(JSON.stringify(result));
    process.exit(0);
  })
  .catch((error) => {
    console.error(JSON.stringify({
      success: false,
      error: error.message || "Request failed",
      status_code: error.response?.status || 500,
    }));
    process.exit(1);
  });
