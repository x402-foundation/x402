import { config } from "dotenv";
import axios from "axios";
import { wrapAxiosWithPayment, decodePaymentResponseHeader } from "@x402/axios";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { ExactEvmScheme, type ExactEvmSchemeOptions } from "@x402/evm/exact/client";
import {
  UptoEvmScheme as UptoEvmClientScheme,
  type UptoEvmSchemeOptions,
} from "@x402/evm/upto/client";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { toClientEvmSigner } from "@x402/evm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { ExactSvmSchemeV1 } from "@x402/svm/v1";
import { ExactAptosScheme } from "@x402/aptos/exact/client";
import { Account, Ed25519PrivateKey, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";
import { createClientHederaSigner, PrivateKey as HederaPrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { ExactKeetaScheme } from "@x402/keeta/exact/client";
import { toClientKeetaSigner, KEETA_TESTNET_CAIP2, ClientKeetaSigner } from "@x402/keeta";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer, type Ed25519Signer } from "@x402/stellar";
import { ExactTvmScheme } from "@x402/tvm/exact/client";
import { toClientTvmSigner, TVM_PROVIDER_TONAPI, TVM_PROVIDER_TONCENTER } from "@x402/tvm";
import { createClientNearSigner, type ClientNearSignerConfig } from "@x402/near";
import { ExactNearScheme as ExactNearClientScheme } from "@x402/near/exact/client";
import { createXrplWalletSigner } from "@x402/xrpl";
import { ExactXrplScheme as ExactXrplClientScheme } from "@x402/xrpl/exact/client";
import { Wallet } from "xrpl";
import { ExactAvmScheme as ExactAvmClientScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { AccountAddress, buildBasicAccountSigner } from "@concordium/web-sdk";
import * as KeetaNet from "@keetanetwork/keetanet-client";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { keyPairFromSeed, type KeyPair } from "@ton/crypto";
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
const svmSchemeOptions = process.env.SVM_RPC_URL ? { rpcUrl: process.env.SVM_RPC_URL } : undefined;

const ccdPrivateKey = process.env.CCD_PRIVATE_KEY;
const ccdAddress = process.env.CCD_ADDRESS;

/**
 * Parses the TVM private key accepted by e2e env fixtures.
 *
 * @param privateKey - Hex or base64 seed/secret key.
 * @returns Key pair derived from the first 32 seed bytes.
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

// Batch-settlement scheme uses a per-scenario salt (CHANNEL_SALT) so concurrent
// e2e runs don't collide on the same on-chain channel id. An optional voucher
// signer (EVM_VOUCHER_SIGNER_PRIVATE_KEY) exercises the alt-EOA voucher branch
// while deposits keep using the main client signer.
const channelSalt = process.env.CHANNEL_SALT as `0x${string}` | undefined;
const voucherSignerKey = process.env.EVM_VOUCHER_SIGNER_PRIVATE_KEY as `0x${string}` | undefined;
const voucherSigner = voucherSignerKey
  ? toClientEvmSigner(privateKeyToAccount(voucherSignerKey), publicClient)
  : undefined;
const batchSettlementOptions =
  channelSalt || voucherSigner
    ? { ...(channelSalt ? { salt: channelSalt } : {}), ...(voucherSigner ? { voucherSigner } : {}) }
    : undefined;
const batchSettlementScheme = new BatchSettlementEvmScheme(evmSigner, batchSettlementOptions);

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

// Initialize Hedera signer if account + key are provided
let hederaClientSigner: ReturnType<typeof createClientHederaSigner> | undefined;
if (process.env.HEDERA_ACCOUNT_ID && process.env.HEDERA_PRIVATE_KEY) {
  hederaClientSigner = createClientHederaSigner(
    process.env.HEDERA_ACCOUNT_ID,
    HederaPrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY),
    {
      network: process.env.HEDERA_NETWORK || "hedera:testnet",
      nodeUrl: process.env.HEDERA_NODE_URL || undefined,
    },
  );
}

// Initialize Keeta signer if mnemonic is provided
let keetaSigner: ClientKeetaSigner | undefined;
if (process.env.KEETA_CLIENT_MNEMONIC) {
  const keetaAccount = KeetaNet.lib.Account.fromSeed(
    await KeetaNet.lib.Account.seedFromPassphrase(process.env.KEETA_CLIENT_MNEMONIC),
    0,
  );
  keetaSigner = toClientKeetaSigner(keetaAccount);
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

const tvmNetwork = process.env.TVM_NETWORK || "tvm:-3";
const tvmPrivateKey = process.env.TVM_PRIVATE_KEY;
const tvmProvider = (process.env.TVM_PROVIDER || TVM_PROVIDER_TONCENTER).toLowerCase();
const tvmScheme = tvmPrivateKey
  ? new ExactTvmScheme(
      toClientTvmSigner(parseTvmKeyPair(tvmPrivateKey), {
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
      }),
    )
  : undefined;

const client = new x402Client()
  .register("eip155:*", new ExactEvmScheme(evmSigner, evmSchemeOptions))
  .register("eip155:*", new UptoEvmClientScheme(evmSigner, uptoSchemeOptions))
  .register("eip155:*", batchSettlementScheme)
  .registerV1("base-sepolia", new ExactEvmSchemeV1(evmSigner))
  .registerV1("base", new ExactEvmSchemeV1(evmSigner))
  .register("solana:*", new ExactSvmScheme(svmSigner, svmSchemeOptions))
  .registerV1("solana-devnet", new ExactSvmSchemeV1(svmSigner, svmSchemeOptions))
  .registerV1("solana", new ExactSvmSchemeV1(svmSigner, svmSchemeOptions));
if (ccdPrivateKey && ccdAddress) {
  client.register(
    "ccd:*",
    new ExactConcordiumScheme(
      {
        accountAddress: AccountAddress.fromBase58(ccdAddress),
        signer: buildBasicAccountSigner(ccdPrivateKey),
      },
      process.env.CCD_GRPC_URL ? { grpcUrl: process.env.CCD_GRPC_URL } : undefined,
    ),
  );
}
if (aptosAccount) {
  client.register("aptos:*", new ExactAptosScheme(aptosAccount));
}
if (hederaClientSigner) {
  client.register("hedera:*", new ExactHederaScheme(hederaClientSigner));
}
if (keetaSigner) {
  client.register(KEETA_TESTNET_CAIP2, new ExactKeetaScheme(keetaSigner));
}
if (stellarSigner) {
  client.register("stellar:*", new ExactStellarScheme(stellarSigner));
}
if (avmSigner) {
  client.register("algorand:*", new ExactAvmClientScheme(avmSigner));
}
if (tvmScheme) {
  client.register("tvm:*", tvmScheme);
}
if (process.env.NEAR_ACCOUNT_ID && process.env.NEAR_PRIVATE_KEY) {
  const nearNetwork = (process.env.NEAR_NETWORK || "near:testnet") as `${string}:${string}`;
  const nearSigner = createClientNearSigner({
    accountId: process.env.NEAR_ACCOUNT_ID,
    secretKey: process.env.NEAR_PRIVATE_KEY as ClientNearSignerConfig["secretKey"],
    rpcUrls: process.env.NEAR_RPC_URL ? { [nearNetwork]: process.env.NEAR_RPC_URL } : undefined,
  });
  client.register(nearNetwork, new ExactNearClientScheme(nearSigner));
}
if (process.env.XRPL_SEED) {
  const xrplNetwork = (process.env.XRPL_NETWORK || "xrpl:1") as `xrpl:${number}`;
  const xrplSigner = createXrplWalletSigner(Wallet.fromSeed(process.env.XRPL_SEED));
  client.register(
    xrplNetwork,
    new ExactXrplClientScheme(
      xrplSigner,
      process.env.XRPL_WS_URL
        ? { wsUrlByNetwork: { [xrplNetwork]: process.env.XRPL_WS_URL } }
        : {},
    ),
  );
}

const axiosWithPayment = wrapAxiosWithPayment(axios.create(), client);

const batchSettlementPhase = process.env.BATCH_SETTLEMENT_PHASE as
  | "initial"
  | "recovery-refund"
  | "full"
  | undefined;

/**
 * Issues a single paid request and returns the parsed result.
 *
 * @returns Structured result with response data and decoded payment-response.
 */
interface RequestResult {
  success: boolean;
  data: unknown;
  status_code: number;
  payment_response?: unknown;
}

/**
 * Issues a single paid request and returns the parsed result.
 *
 * @returns Structured result with response data and decoded payment-response.
 */
async function issueRequest(): Promise<RequestResult> {
  const response = await axiosWithPayment.get(url);
  const paymentResponseHeader =
    response.headers["payment-response"] || response.headers["x-payment-response"];

  if (!paymentResponseHeader) {
    return { success: true, data: response.data, status_code: response.status };
  }

  const decodedPaymentResponse = decodePaymentResponseHeader(paymentResponseHeader);
  return {
    success: decodedPaymentResponse.success,
    data: response.data,
    status_code: response.status,
    payment_response: decodedPaymentResponse,
  };
}

/**
 * Combines the multi-request batch-settlement phases into one e2e result.
 *
 * @param phase - Current batch-settlement scenario phase.
 * @param results - Ordered request results included in the aggregate.
 * @param details - Named request results for easier test assertions.
 * @returns Aggregated e2e client result.
 */
function aggregateBatchResult(
  phase: "initial" | "recovery-refund" | "full",
  results: RequestResult[],
  details: Record<string, RequestResult>,
) {
  const last = results[results.length - 1]!;
  return {
    success: results.every(result => result.success),
    data: {
      batchSettlement: {
        phase,
        requests: results,
        ...details,
      },
    },
    status_code: last.status_code,
    payment_response: last.payment_response,
  };
}

try {
  if (!batchSettlementPhase) {
    const result = await issueRequest();
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (batchSettlementPhase === "initial") {
    const deposit = await issueRequest();
    const voucher = await issueRequest();
    console.log(
      JSON.stringify(aggregateBatchResult("initial", [deposit, voucher], { deposit, voucher })),
    );
    process.exit(0);
  }

  if (batchSettlementPhase === "recovery-refund") {
    const recoveryVoucher = await issueRequest();
    const refundSettle = await batchSettlementScheme.refund(url);
    const refund = {
      success: refundSettle.success,
      data: { refund: true },
      status_code: 200,
      payment_response: refundSettle,
    };
    console.log(
      JSON.stringify(
        aggregateBatchResult("recovery-refund", [recoveryVoucher, refund], {
          recoveryVoucher,
          refund,
        }),
      ),
    );
    process.exit(0);
  }

  if (batchSettlementPhase === "full") {
    const deposit = await issueRequest();
    const voucher = await issueRequest();
    const refundSettle = await batchSettlementScheme.refund(url);
    const refund = {
      success: refundSettle.success,
      data: { refund: true },
      status_code: 200,
      payment_response: refundSettle,
    };
    console.log(
      JSON.stringify(
        aggregateBatchResult("full", [deposit, voucher, refund], { deposit, voucher, refund }),
      ),
    );
    process.exit(0);
  }

  throw new Error(`Unknown BATCH_SETTLEMENT_PHASE: ${batchSettlementPhase}`);
} catch (error: unknown) {
  const err = error as { message?: string; response?: { status?: number } };
  console.error(
    JSON.stringify({
      success: false,
      error: err.message || "Request failed",
      status_code: err.response?.status || 500,
    }),
  );
  process.exit(1);
}
