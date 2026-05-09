import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { BatchSettlementEvmScheme, RedisChannelStorage } from "@x402/evm/batch-settlement/server";
import { privateKeyToAccount } from "viem/accounts";

import { createLazyRedisChannelStorageClient } from "./redisChannelClient";

export const NETWORK = "eip155:84532" as const;

const facilitatorUrl = process.env.FACILITATOR_URL;
const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const redisUrl = process.env.REDIS_URL;

const receiverAuthorizerPrivateKey = process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY as
  | `0x${string}`
  | undefined;

const withdrawDelay = Number(process.env.DEFERRED_WITHDRAW_DELAY_SECONDS ?? "108000");

if (!facilitatorUrl) {
  console.error("Missing required FACILITATOR_URL environment variable");
  process.exit(1);
}

if (!evmAddress || !/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) {
  console.error("Missing or invalid EVM_ADDRESS (checksummed 20-byte hex, 0x-prefixed)");
  process.exit(1);
}

if (!redisUrl) {
  console.error("Missing required REDIS_URL environment variable");
  process.exit(1);
}

const receiverAuthorizerSigner = receiverAuthorizerPrivateKey
  ? privateKeyToAccount(receiverAuthorizerPrivateKey)
  : undefined;

export const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const redisAdapter = createLazyRedisChannelStorageClient(redisUrl);

export const batchedScheme = new BatchSettlementEvmScheme(evmAddress, {
  ...(receiverAuthorizerSigner ? { receiverAuthorizerSigner } : {}),
  withdrawDelay,
  storage: new RedisChannelStorage({ client: redisAdapter }),
});

export const server = new x402ResourceServer(facilitatorClient).register(NETWORK, batchedScheme);
export const channelManager = batchedScheme.createChannelManager(facilitatorClient, NETWORK);

/** Release the Redis connection (required for CLI cron scripts to exit). */
export async function disconnectRedisChannelStorage(): Promise<void> {
  await redisAdapter.disconnect();
}

export { evmAddress };
