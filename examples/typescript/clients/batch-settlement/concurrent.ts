import { toClientEvmSigner, type ClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { config } from "dotenv";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

config();

const evmPrivateKeyRaw = process.env.EVM_PRIVATE_KEY?.trim();
if (!evmPrivateKeyRaw) {
  console.error("EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}
const evmPrivateKey = evmPrivateKeyRaw as `0x${string}`;
const evmVoucherSignerPrivateKey = process.env.EVM_VOUCHER_SIGNER_PRIVATE_KEY?.trim() || undefined;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;
const storageDir = process.env.STORAGE_DIR;
// Managed-mode packing uses only low-96-bit channel indices.
const UINT96_MAX = (1n << 96n) - 1n;
// Dedicated env var (not CHANNEL_SALT) so this example never shares a channel with `pnpm start`.
const concurrentChannelSaltRaw = process.env.CONCURRENT_CHANNEL_SALT?.trim() || "0x1000";
const numberOfRequests = Number(process.env.NUMBER_OF_REQUESTS ?? "3");
const numberOfChannels = Number(process.env.NUMBER_OF_CHANNELS ?? "3");
const refundAfterRequests = process.env.REFUND_AFTER_REQUESTS === "true";
const refundAmount = process.env.REFUND_AMOUNT;
const depositMultiplier = Number(process.env.DEPOSIT_MULTIPLIER ?? "5");

/**
 * Derives one distinct, consecutive channel salt per channel from a base salt.
 *
 * @param raw - Base salt as a decimal or 0x-hex integer string.
 * @param count - Number of channels to derive salts for.
 * @returns The derived channel salts, base salt first.
 */
function deriveChannelSalts(raw: string, count: number): bigint[] {
  let base: bigint;
  try {
    base = BigInt(raw);
  } catch {
    throw new Error(`CONCURRENT_CHANNEL_SALT must be a decimal or 0x-hex integer, got "${raw}"`);
  }
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("NUMBER_OF_CHANNELS must be a positive integer");
  }
  if (base < 0n || base + BigInt(count - 1) > UINT96_MAX) {
    throw new Error(
      `CONCURRENT_CHANNEL_SALT (${raw}) + ${count - 1} must fit in 96 bits (< 2^96): larger salts ` +
        "are truncated by refundAuthorizer packing and would collapse into a single channel",
    );
  }
  const salts = Array.from({ length: count }, (_, index) => base + BigInt(index));
  if (new Set(salts).size !== salts.length) {
    throw new Error("Derived channel salts are not distinct");
  }
  return salts;
}

type ClientContext = {
  signer: ClientEvmSigner;
  voucherSigner: ClientEvmSigner | undefined;
};

/**
 * Creates a batch-settlement EVM scheme bound to a single channel salt.
 *
 * @param ctx - Shared client context holding the payer and optional voucher signers.
 * @param channelSalt - Salt that identifies this channel.
 * @param channelIndex - Index of the channel, used to derive its storage subdirectory.
 * @returns A batch-settlement scheme configured for the given channel.
 */
function createBatchedScheme(
  ctx: ClientContext,
  channelSalt: bigint,
  channelIndex: number,
): BatchSettlementEvmScheme {
  const channelStorageDir = storageDir
    ? `${storageDir.replace(/\/$/, "")}/channel-${channelIndex}`
    : undefined;

  return new BatchSettlementEvmScheme(ctx.signer, {
    depositPolicy: {
      depositMultiplier,
    },
    salt: channelSalt,
    ...(ctx.voucherSigner ? { voucherSigner: ctx.voucherSigner } : {}),
    ...(channelStorageDir
      ? { storage: new FileClientChannelStorage({ directory: channelStorageDir }) }
      : {}),
  });
}

/**
 * Sends a series of paid requests over one channel, then optionally requests a refund.
 *
 * @param options - Channel run configuration.
 * @param options.label - Human-readable label used in log output.
 * @param options.channelSalt - Salt of the channel being used, used for logging.
 * @param options.batchedScheme - Batch-settlement scheme that signs payments for this channel.
 * @param options.requestCount - Number of paid requests to send.
 * @returns A promise that resolves once all requests (and the optional refund) complete.
 */
async function runChannelPayments(options: {
  label: string;
  channelSalt: bigint;
  batchedScheme: BatchSettlementEvmScheme;
  requestCount: number;
}): Promise<void> {
  const { label, channelSalt, batchedScheme, requestCount } = options;

  const client = new x402Client();
  client.register("eip155:*", batchedScheme);
  client.setSpendControls({
    maxAmountPerPayment: "$1",
  });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);

  console.log(`${label} — channel salt: ${channelSalt}`);

  for (let i = 0; i < requestCount; i++) {
    const requestT0 = performance.now();

    const response = await fetchWithPayment(url, { method: "GET" });
    const result = await httpClient.processResponse(response);

    if (result.paymentStatus === "settled") {
      console.log(`${label} — Request ${i + 1} — RESPONSE`);
      console.log(result.body);
      console.log(JSON.stringify(result.header, null, 2));
    } else {
      console.log(`${label} — Request ${i + 1} — no settlement`);
      console.log(JSON.stringify(result, null, 2));
    }
    console.log(
      `${label} — Request ${i + 1} — completed in ${((performance.now() - requestT0) / 1000).toFixed(3)}s\n`,
    );
  }

  if (refundAfterRequests) {
    console.log(
      refundAmount
        ? `${label} — REQUESTING PARTIAL REFUND of ${refundAmount} base units`
        : `${label} — REQUESTING FULL REFUND of remaining channel balance`,
    );
    const refundT0 = performance.now();
    const settle = await batchedScheme.refund(url, {
      ...(refundAmount ? { amount: refundAmount } : {}),
    });
    console.log(JSON.stringify(settle, null, 2));
    console.log(
      `${label} — Refund completed in ${((performance.now() - refundT0) / 1000).toFixed(3)}s`,
    );
  }
}

/**
 * Validates configuration, then runs payments across all channels concurrently.
 *
 * @returns A promise that resolves once every channel has finished.
 */
async function main(): Promise<void> {
  if (!Number.isFinite(numberOfRequests) || numberOfRequests <= 0) {
    console.error("NUMBER_OF_REQUESTS must be a positive number");
    process.exit(1);
  }
  if (!Number.isFinite(numberOfChannels) || numberOfChannels <= 0) {
    console.error("NUMBER_OF_CHANNELS must be a positive number");
    process.exit(1);
  }

  let channelSalts: bigint[];
  try {
    channelSalts = deriveChannelSalts(concurrentChannelSaltRaw, numberOfChannels);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  const account = privateKeyToAccount(evmPrivateKey);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });
  const signer = toClientEvmSigner(account, publicClient);

  const voucherSigner = evmVoucherSignerPrivateKey
    ? toClientEvmSigner(privateKeyToAccount(evmVoucherSignerPrivateKey as `0x${string}`))
    : undefined;

  const ctx: ClientContext = { signer, voucherSigner };

  console.log(`Base URL: ${baseURL}, endpoint: ${endpointPath}`);
  console.log("payer (same EOA, distinct channels via salt):", signer.address);
  console.log("payerAuthorizer:", voucherSigner?.address ?? signer.address);
  console.log(
    `Channels: ${numberOfChannels} (salts ${concurrentChannelSaltRaw} + 0..${numberOfChannels - 1})`,
  );
  console.log(`Payments per channel: ${numberOfRequests}\n`);

  await Promise.all(
    Array.from({ length: numberOfChannels }, async (_, channelIndex) => {
      const salt = channelSalts[channelIndex];
      const batchedScheme = createBatchedScheme(ctx, salt, channelIndex);
      const label = `Channel ${channelIndex + 1}/${numberOfChannels}`;

      await runChannelPayments({
        label,
        channelSalt: salt,
        batchedScheme,
        requestCount: numberOfRequests,
      });
    }),
  );
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
