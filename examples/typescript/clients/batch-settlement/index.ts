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
const svmChannelSalt = process.env.SVM_CHANNEL_SALT?.trim() || "0";
const numberOfRequests = Number(process.env.NUMBER_OF_REQUESTS ?? "3");
const refundAfterRequests = process.env.REFUND_AFTER_REQUESTS === "true";
const refundAmount = process.env.REFUND_AMOUNT;
const depositMultiplier = Number(process.env.DEPOSIT_MULTIPLIER ?? "5");
const svmRpcUrl = process.env.SVM_RPC_URL;
// Operator keys allowed to sign vouchers on this client's behalf. A
// server-signed channel lets that operator claim up to the whole escrow, so
// nothing here is trusted because a 402 asked for it; the cap below is what a
// dishonest operator could take.
const svmServerSignedOperators = (process.env.SVM_SERVER_SIGNED_OPERATORS ?? "")
  .split(",")
  .map(key => key.trim())
  .filter(Boolean);
const svmServerSignedMaxDeposit = process.env.SVM_SERVER_SIGNED_MAX_DEPOSIT?.trim() || "$0.05";

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
  let svmScheme: BatchSvmScheme | undefined;

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
    svmScheme = new BatchSvmScheme(svmSigner, {
      depositPolicy: { depositMultiplier },
      salt: svmChannelSalt,
      ...(svmRpcUrl ? { rpcUrl: svmRpcUrl } : {}),
      ...(svmServerSignedOperators.length > 0
        ? {
            serverSignedChannelsPolicy: {
              allowedOperators: svmServerSignedOperators,
              // USD cap for default assets; list other tokens under
              // `allowedAssets` with an atomic `maxDeposit`.
              maxDeposit: svmServerSignedMaxDeposit,
            },
          }
        : {}),
    });
    client.register("solana:*", svmScheme);
    // Optional: prefer a trusted operator's metered accept over the same
    // route's fixed-price accept. Safety does not depend on this; an untrusted
    // server-signed accept is refused and the scheme falls back to the
    // client-signed accept on its own.
    client.registerPolicy(svmScheme.paymentPolicy);

    console.log("SVM payer:", svmSigner.address);
    console.log("SVM channel salt:", svmChannelSalt);
    console.log(
      "SVM server-signed channels:",
      svmServerSignedOperators.length > 0
        ? `trusted operators ${svmServerSignedOperators.join(", ")} up to ${svmServerSignedMaxDeposit} per channel`
        : "refused (client-signed vouchers only)",
    );
  }

  const httpClient = new x402HTTPClient(client);
  const fetchWithPayment = wrapFetchWithPayment(fetch, httpClient);

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
    if (!evmScheme && !svmScheme) {
      console.warn("No batch-settlement scheme is available to refund");
      return;
    }
    if (refundAmount && !evmScheme) {
      throw new Error("SVM batch settlement supports only a full refund");
    }
    console.log(
      refundAmount
        ? `REQUESTING PARTIAL REFUND of ${refundAmount} base units`
        : "REQUESTING FULL REFUND of remaining channel balance",
    );
    // Each registered scheme refunds its own channel, so a dual-network run
    // closes both the EVM and the SVM channel.
    if (evmScheme) {
      const refundT0 = performance.now();
      const settle = await evmScheme.refund(url, {
        ...(refundAmount ? { amount: refundAmount } : {}),
      });
      console.log("[EVM]", JSON.stringify(settle, null, 2));
      console.log(
        `[EVM] Refund completed in ${((performance.now() - refundT0) / 1000).toFixed(3)}s`,
      );
    }
    if (svmScheme) {
      const refundT0 = performance.now();
      const settle = await svmScheme.refund(url);
      console.log("[SVM]", JSON.stringify(settle, null, 2));
      console.log(
        `[SVM] Refund completed in ${((performance.now() - refundT0) / 1000).toFixed(3)}s`,
      );
    }
  }
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
