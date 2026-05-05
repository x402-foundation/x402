import { toClientEvmSigner } from "@x402/evm";
import {
  BatchSettlementEvmScheme,
  FileClientChannelStorage,
} from "@x402/evm/batch-settlement/client";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { config } from "dotenv";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const evmVoucherSignerPrivateKey = process.env.EVM_VOUCHER_SIGNER_PRIVATE_KEY as
  | `0x${string}`
  | undefined;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;
const storageDir = process.env.STORAGE_DIR ?? process.env.STORAGE_DIR_DIR;
const channelSalt = (process.env.CHANNEL_SALT ??
  "0x0000000000000000000000000000000000000000000000000000000000000000") as `0x${string}`;
const numberOfRequests = Number(process.env.NUMBER_OF_REQUESTS ?? "3");
const refundAfterRequests = process.env.REFUND_AFTER_REQUESTS === "true";
const refundAmount = process.env.REFUND_AMOUNT;
const depositMultiplier = Number(process.env.DEPOSIT_MULTIPLIER ?? "5");

/**
 * Runs sequential paid requests against the configured resource server endpoint.
 *
 * @returns Resolves after all configured requests complete.
 */
async function main(): Promise<void> {
  const account = privateKeyToAccount(evmPrivateKey);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });
  const signer = toClientEvmSigner(account, publicClient);

  const voucherSigner =
    evmVoucherSignerPrivateKey !== undefined
      ? toClientEvmSigner(privateKeyToAccount(evmVoucherSignerPrivateKey))
      : undefined;

  const batchedScheme = new BatchSettlementEvmScheme(signer, {
    depositPolicy: {
      depositMultiplier,
    },
    salt: channelSalt,
    ...(voucherSigner ? { voucherSigner } : {}),
    ...(storageDir ? { storage: new FileClientChannelStorage({ directory: storageDir }) } : {}),
  });

  const client = new x402Client();
  client.register("eip155:*", batchedScheme);

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);

  console.log(`Base URL: ${baseURL}, endpoint: ${endpointPath}`);
  console.log("payer:", signer.address);
  console.log("payerAuthorizer:", voucherSigner?.address ?? signer.address, "\n");

  for (let i = 0; i < numberOfRequests; i++) {
    const requestT0 = performance.now();

    const response = await fetchWithPayment(url, { method: "GET" });
    const result = await httpClient.processResponse(response);

    if (result.kind === "success") {
      console.log(`Request ${i + 1} — RESPONSE`);
      console.log(result.body);
      console.log(JSON.stringify(result.settleResponse, null, 2));
    } else {
      console.log(`Request ${i + 1} — ${result.kind}`);
      console.log(JSON.stringify(result, null, 2));
    }
    console.log(
      `Request ${i + 1} — completed in ${((performance.now() - requestT0) / 1000).toFixed(3)}s\n`,
    );
  }

  if (refundAfterRequests) {
    console.log(
      refundAmount
        ? `REQUESTING PARTIAL REFUND of ${refundAmount} base units`
        : "REQUESTING FULL REFUND of remaining channel balance",
    );
    const refundT0 = performance.now();
    const settle = await batchedScheme.refund(url, {
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
