import { config } from "dotenv";
import { wrapFetchWithPayment } from "@x402/fetch";
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
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer, Ed25519Signer } from "@x402/stellar";
import { ExactAvmScheme as ExactAvmClientScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";

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

// Batch-settlement scheme uses a per-scenario salt (CHANNEL_SALT) so concurrent
// e2e runs don't collide on the same on-chain channel id. An optional voucher
// signer (EVM_VOUCHER_SIGNER_PRIVATE_KEY) exercises the alt-EOA voucher branch
// while deposits keep using the main client signer.
const channelSalt = process.env.CHANNEL_SALT as `0x${string}` | undefined;
const voucherSignerKey = process.env.EVM_VOUCHER_SIGNER_PRIVATE_KEY as
  | `0x${string}`
  | undefined;
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
  .register("eip155:*", batchSettlementScheme)
  .registerV1("base-sepolia", new ExactEvmSchemeV1(evmSigner))
  .registerV1("base", new ExactEvmSchemeV1(evmSigner))
  .register("solana:*", new ExactSvmScheme(svmSigner))
  .registerV1("solana-devnet", new ExactSvmSchemeV1(svmSigner))
  .registerV1("solana", new ExactSvmSchemeV1(svmSigner));
if (aptosAccount) {
  client.register("aptos:*", new ExactAptosScheme(aptosAccount));
}
if (hederaClientSigner) {
  client.register("hedera:*", new ExactHederaScheme(hederaClientSigner));
}
if (stellarSigner) {
  client.register("stellar:*", new ExactStellarScheme(stellarSigner));
}
if (avmSigner) {
  client.register("algorand:*", new ExactAvmClientScheme(avmSigner));
}

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

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
  payment_response?: any;
}

async function issueRequest(): Promise<RequestResult> {
  const response = await fetchWithPayment(url, { method: "GET" });
  const data = await response.json();
  const paymentResponse = httpClient.getPaymentSettleResponse(name => response.headers.get(name));

  if (!paymentResponse) {
    return { success: true, data, status_code: response.status };
  }

  return {
    success: paymentResponse.success,
    data,
    status_code: response.status,
    payment_response: paymentResponse,
  };
}

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

if (!batchSettlementPhase) {
  const result = await issueRequest();
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (batchSettlementPhase === "initial") {
  const deposit = await issueRequest();
  const voucher = await issueRequest();
  console.log(JSON.stringify(aggregateBatchResult("initial", [deposit, voucher], { deposit, voucher })));
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
  console.log(JSON.stringify(aggregateBatchResult("full", [deposit, voucher, refund], { deposit, voucher, refund })));
  process.exit(0);
}

throw new Error(`Unknown BATCH_SETTLEMENT_PHASE: ${batchSettlementPhase}`);
