import type {
  RedisChannelStorageClient,
  RedisEvalOptions,
  RedisScanOptions,
  RedisSetOptions,
} from "@x402/evm/batch-settlement/server";
import { createClient } from "redis";

export type LazyRedisChannelStorageClient = RedisChannelStorageClient & {
  /** Close the TCP connection */
  disconnect: () => Promise<void>;
};

/**
 * Wraps a lazily connected node-redis client as {@link RedisChannelStorageClient}.
 *
 * @param url - Redis connection URL (same shape as `REDIS_URL` / `redis://…`).
 * @returns An adapter compatible with Redis-backed batch-settlement channel storage.
 */
export function createLazyRedisChannelStorageClient(url: string): LazyRedisChannelStorageClient {
  const connect = async () => {
    const client = createClient({ url });
    client.on("error", err => {
      console.error("Redis client error:", err);
    });
    await client.connect();
    return client;
  };

  let connecting: Promise<Awaited<ReturnType<typeof connect>>> | undefined;

  const ensureClient = () => {
    if (!connecting) connecting = connect();
    return connecting;
  };

  const normalizeRedisString = (value: string | Buffer | null): string | null => {
    if (value == null) return null;
    return typeof value === "string" ? value : value.toString("utf8");
  };

  const normalizeScanKey = (key: string | Buffer): string =>
    typeof key === "string" ? key : key.toString("utf8");

  return {
    disconnect: async () => {
      if (!connecting) return;
      try {
        const c = await connecting;
        if (c.isOpen) await c.quit();
      } catch {
        // connect or quit failed — still drop the handle so the process can exit
      } finally {
        connecting = undefined;
      }
    },
    get: key =>
      ensureClient()
        .then(c => c.get(key))
        .then(normalizeRedisString),
    set: (key, value, opts?: RedisSetOptions) =>
      ensureClient()
        .then(c => {
          if (opts?.NX) {
            return c.set(key, value, {
              NX: true,
              ...(opts.PX !== undefined ? { PX: opts.PX } : {}),
            });
          }
          if (opts?.PX !== undefined) {
            return c.set(key, value, { PX: opts.PX });
          }
          return c.set(key, value);
        })
        .then(normalizeRedisString),
    del: key =>
      ensureClient()
        .then(c => c.del(key))
        .then(n => Number(n)),
    eval: (script, options: RedisEvalOptions) => ensureClient().then(c => c.eval(script, options)),
    scanIterator(options: RedisScanOptions): AsyncIterable<string | string[]> {
      return {
        async *[Symbol.asyncIterator]() {
          const c = await ensureClient();
          for await (const chunk of c.scanIterator(options)) {
            if (Array.isArray(chunk)) {
              yield chunk.map(normalizeScanKey);
              continue;
            }
            yield normalizeScanKey(chunk);
          }
        },
      };
    },
  };
}
