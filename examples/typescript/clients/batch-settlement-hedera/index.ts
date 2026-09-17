import {
  createClientHederaBatchSigner,
  parseHederaPrivateKey,
} from "@x402/hedera/batch-settlement";
import { BatchSettlementHederaScheme } from "@x402/hedera/batch-settlement/client";
import { FileClientChannelStorage } from "@x402/hedera/batch-settlement/client/file-storage";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { config } from "dotenv";

config();

const network = (process.env.HEDERA_NETWORK || "hedera:testnet") as `${string}:${string}`;
const accountId = process.env.HEDERA_ACCOUNT_ID?.trim();
const privateKeyRaw = process.env.HEDERA_PRIVATE_KEY?.trim();
if (!accountId || !privateKeyRaw) {
  console.error("HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY environment variables are required");
  process.exit(1);
}
const voucherSignerId = process.env.HEDERA_VOUCHER_SIGNER_ACCOUNT_ID?.trim() || undefined;
const voucherSignerKey = process.env.HEDERA_VOUCHER_SIGNER_PRIVATE_KEY?.trim() || undefined;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;
const storageDir = process.env.STORAGE_DIR;
const channelSalt = (process.env.CHANNEL_SALT ??
  "0x0000000000000000000000000000000000000000000000000000000000000000") as `0x${string}`;
const numberOfRequests = Number(process.env.NUMBER_OF_REQUESTS ?? "3");
const refundAfterRequests = process.env.REFUND_AFTER_REQUESTS === "true";
const refundAmount = process.env.REFUND_AMOUNT || undefined;
const depositMultiplier = Number(process.env.DEPOSIT_MULTIPLIER ?? "5");

/**
 * Runs sequential paid requests against the configured resource server endpoint.
 */
async function main(): Promise<void> {
  const signer = await createClientHederaBatchSigner(
    accountId!,
    parseHederaPrivateKey(privateKeyRaw!),
    {
      network,
    },
  );
  const voucherSigner =
    voucherSignerId && voucherSignerKey
      ? await createClientHederaBatchSigner(
          voucherSignerId,
          parseHederaPrivateKey(voucherSignerKey),
          {
            network,
          },
        )
      : undefined;

  const batchedScheme = new BatchSettlementHederaScheme(signer, {
    depositPolicy: { depositMultiplier },
    salt: channelSalt,
    ...(voucherSigner ? { voucherSigner } : {}),
    ...(storageDir ? { storage: new FileClientChannelStorage({ directory: storageDir }) } : {}),
  });

  const client = new x402Client();
  client.register("hedera:*", batchedScheme);
  client.setSpendControls({ maxAmountPerPayment: "$1" });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);

  console.log(`Base URL: ${baseURL}, endpoint: ${endpointPath}`);
  console.log(`payer: ${signer.accountId} (${signer.evmAddress}, ${signer.keyType})`);
  console.log(`payerAuthorizer: ${voucherSigner?.evmAddress ?? signer.evmAddress}\n`);

  for (let i = 0; i < numberOfRequests; i++) {
    const t0 = performance.now();
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
      `Request ${i + 1} — completed in ${((performance.now() - t0) / 1000).toFixed(3)}s\n`,
    );
  }

  if (refundAfterRequests) {
    console.log(
      refundAmount
        ? `REQUESTING PARTIAL REFUND of ${refundAmount} base units`
        : "REQUESTING FULL REFUND of remaining channel balance",
    );
    const t0 = performance.now();
    const settle = await batchedScheme.refund(url, {
      ...(refundAmount ? { amount: refundAmount } : {}),
    });
    console.log(JSON.stringify(settle, null, 2));
    console.log(`Refund completed in ${((performance.now() - t0) / 1000).toFixed(3)}s`);
  }
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
