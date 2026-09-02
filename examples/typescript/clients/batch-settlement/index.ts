import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { BatchSvmScheme } from "@x402/svm/batch-settlement/client";
import { config } from "dotenv";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

config();

const evmPrivateKeyRaw = process.env.EVM_PRIVATE_KEY?.trim();
const svmPrivateKeyRaw = process.env.SVM_PRIVATE_KEY?.trim();
const evmVoucherSignerPrivateKey = process.env.EVM_VOUCHER_SIGNER_PRIVATE_KEY?.trim() || undefined;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;
const storageDir = process.env.STORAGE_DIR;
const channelSalt = (process.env.CHANNEL_SALT ??
  "0x0000000000000000000000000000000000000000000000000000000000000000") as `0x${string}`;
const numberOfRequests = Number(process.env.NUMBER_OF_REQUESTS ?? "3");
const refundAfterRequests = process.env.REFUND_AFTER_REQUESTS === "true";
const refundAmount = process.env.REFUND_AMOUNT;
const depositMultiplier = Number(process.env.DEPOSIT_MULTIPLIER ?? "5");
const svmRpcUrl = process.env.SVM_RPC_URL;
const svmDepositAmount = process.env.SVM_DEPOSIT_AMOUNT;

if (!evmPrivateKeyRaw && !svmPrivateKeyRaw) {
  console.error("At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required");
  process.exit(1);
}

/**
 * Runs sequential paid requests against the configured resource server endpoint.
 *
 * @returns Resolves after all configured requests complete.
 */
async function main(): Promise<void> {
  const client = new x402Client().setSpendControls({
    maxAmountPerPayment: "$1",
  });
  let evmScheme: BatchSettlementEvmScheme | undefined;

  if (evmPrivateKeyRaw) {
    const evmPrivateKey = evmPrivateKeyRaw as `0x${string}`;
    const account = privateKeyToAccount(evmPrivateKey);
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(),
    });
    const signer = toClientEvmSigner(account, publicClient);

    const voucherSigner = evmVoucherSignerPrivateKey
      ? toClientEvmSigner(privateKeyToAccount(evmVoucherSignerPrivateKey as `0x${string}`))
      : undefined;

    evmScheme = new BatchSettlementEvmScheme(signer, {
      depositPolicy: {
        depositMultiplier,
      },
      salt: channelSalt,
      ...(voucherSigner ? { voucherSigner } : {}),
      ...(storageDir ? { storage: new FileClientChannelStorage({ directory: storageDir }) } : {}),
    });
    client.register("eip155:*", evmScheme);

    console.log("EVM payer:", signer.address);
    console.log("EVM payerAuthorizer:", voucherSigner?.address ?? signer.address);
  }

  if (svmPrivateKeyRaw) {
    const svmSigner = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKeyRaw));
    const svmScheme = new BatchSvmScheme(svmSigner, {
      ...(svmRpcUrl ? { rpcUrl: svmRpcUrl } : {}),
      ...(svmDepositAmount
        ? { depositAmount: svmDepositAmount }
        : { depositAmount: String(10_000 * depositMultiplier) }),
    });
    client.register("solana:*", svmScheme);

    console.log("SVM payer:", svmSigner.address);
  }

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);

  console.log(`Base URL: ${baseURL}, endpoint: ${endpointPath}\n`);

  for (let i = 0; i < numberOfRequests; i++) {
    const requestT0 = performance.now();

    const response = await fetchWithPayment(url, { method: "GET" });
    const result = await httpClient.processResponse(response);

    if (result.paymentStatus === "settled") {
      console.log(`Request ${i + 1} — RESPONSE`);
      console.log(result.body);
      console.log(JSON.stringify(result.header, null, 2));
    } else {
      console.log(`Request ${i + 1} — no settlement`);
      console.log(JSON.stringify(result, null, 2));
    }
    console.log(
      `Request ${i + 1} — completed in ${((performance.now() - requestT0) / 1000).toFixed(3)}s\n`,
    );
  }

  if (refundAfterRequests) {
    if (!evmScheme) {
      console.warn("REFUND_AFTER_REQUESTS is only supported for EVM in this example");
      return;
    }
    console.log(
      refundAmount
        ? `REQUESTING PARTIAL REFUND of ${refundAmount} base units`
        : "REQUESTING FULL REFUND of remaining channel balance",
    );
    const refundT0 = performance.now();
    const settle = await evmScheme.refund(url, {
      ...(refundAmount ? { amount: refundAmount } : {}),
    });
    console.log(JSON.stringify(settle, null, 2));
    console.log(`Refund completed in ${((performance.now() - refundT0) / 1000).toFixed(3)}s`);
  }
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
