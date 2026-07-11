/**
 * Robinhood Chain x402 Facilitator — MVP
 *
 * Handles verify + settle for x402 exact payments on RH Chain.
 * Uses Permit2 (already deployed on all EVM chains via CREATE2).
 *
 * Flow:
 *   1. Client → Resource Server → 402 Payment Required
 *   2. Client signs Permit2 authorization → Payment-Signature header
 *   3. Resource Server → POST /verify → this facilitator
 *   4. If valid → Resource Server serves data
 *   5. POST /settle → on-chain transfer
 */
import express from "express";
import { randomUUID } from "crypto";
import rateLimit from "express-rate-limit";
import pino from "pino";
import pinoHttp from "pino-http";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyPayment, settlePayment } from "./payment";
import "dotenv/config";

// ── Idempotency / in-flight dedup for /settle ──────────────────────────
// Keyed by `${from}:${nonce}`. Prevents two concurrent /settle calls for
// the same signed authorization from racing to broadcast twice (the
// on-chain nonce guards the money either way, but without this the
// loser gets a confusing RPC-level revert instead of the real result).
// Entries expire after SETTLE_CACHE_TTL_MS so the map doesn't grow
// unbounded under sustained traffic.
type SettleCacheEntry =
  | { status: "pending" }
  | { status: "done"; result: any; expiresAt: number };
const settleCache = new Map<string, SettleCacheEntry>();
const SETTLE_CACHE_TTL_MS = 10 * 60_000; // 10 min — plenty past any maxTimeoutSeconds window
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of settleCache) {
    if (v.status === "done" && v.expiresAt < now) settleCache.delete(k);
  }
}, 60_000).unref();

// ── Metrics (in-process counters, Prometheus text exposition) ──────────
// Deliberately dependency-free: a Map of counters + a couple of latency
// histograms rendered by hand. Good enough for a single-instance testnet
// deploy to scrape 5xx rate, verify/settle success ratio, and P50/P99.
// For a multi-replica mainnet deploy, swap this for prom-client + a shared
// store (same caveat as the rate limiter — see README ops notes).
const metrics = {
  startedAt: Date.now(),
  counters: new Map<string, number>(),
  // Fixed-bucket latency observations (ms) per route.
  latency: new Map<string, number[]>(),
};
function inc(name: string, labels: Record<string, string> = {}) {
  const key = labelKey(name, labels);
  metrics.counters.set(key, (metrics.counters.get(key) || 0) + 1);
}
function observe(route: string, ms: number) {
  const arr = metrics.latency.get(route) || [];
  arr.push(ms);
  // Cap retained samples so memory stays bounded; keep the most recent 1000.
  if (arr.length > 1000) arr.splice(0, arr.length - 1000);
  metrics.latency.set(route, arr);
}
function labelKey(name: string, labels: Record<string, string>): string {
  const l = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",");
  return l ? `${name}{${l}}` : name;
}
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// ── Boot-time config validation (fail-fast, no silent bad defaults) ─────
const PORT = parseInt(process.env.PORT || "3001");
const RH_RPC = process.env.RH_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "46630");

const PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY;
if (!PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
  // eslint-disable-next-line no-console
  console.error(
    "FATAL: FACILITATOR_PRIVATE_KEY env var is missing or malformed. " +
      "Expected a 0x-prefixed 32-byte hex private key. Refusing to boot with an invalid signer.",
  );
  process.exit(1);
}

// ── Structured logging ───────────────────────────────────────────────
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: ["req.headers.authorization", "req.headers.cookie"],
});
const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req.headers["x-request-id"] as string) || randomUUID(),
});

// Robinhood Chain (testnet) config
const robinhoodTestnet = {
  id: CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RH_RPC] } },
};

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

// RPC transport with explicit timeout + retry. Default viem timeout is 10s;
// on a slow RPC that's still long enough to exhaust our connection pool
// under load. Bounded retries (2) with a small backoff smooth over transient
// blips without amplifying an outage.
const RPC_TIMEOUT_MS = parseInt(process.env.RPC_TIMEOUT_MS || "6000");
const RPC_RETRY_COUNT = parseInt(process.env.RPC_RETRY_COUNT || "2");
const RPC_RETRY_DELAY_MS = parseInt(process.env.RPC_RETRY_DELAY_MS || "300");
const rpcTransport = http(RH_RPC, {
  timeout: RPC_TIMEOUT_MS,
  retryCount: RPC_RETRY_COUNT,
  retryDelay: RPC_RETRY_DELAY_MS,
});

const publicClient = createPublicClient({
  chain: robinhoodTestnet,
  transport: rpcTransport,
});

const walletClient = createWalletClient({
  account,
  chain: robinhoodTestnet,
  transport: rpcTransport,
});

// ── Low-balance alerting ───────────────────────────────────────────────
// Fire a webhook (Slack/Discord/PagerDuty-compatible JSON POST) the first
// time the gas balance crosses below the alert threshold, and again on
// recovery. Edge-triggered (not level) so we don't spam on every /health
// poll. ALERT_WEBHOOK_URL unset = alerting disabled (log-only).
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";
// Alert threshold defaults to 2x the hard MIN_GAS floor — warn before we're
// actually degraded, so an operator has runway to top up.
let alertState: "ok" | "low" = "ok";
async function fireAlert(text: string): Promise<void> {
  logger.warn({ alert: text }, "balance alert");
  if (!ALERT_WEBHOOK_URL) return;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4000);
    await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }), // Slack/Discord both accept {text}
      signal: ac.signal,
    }).finally(() => clearTimeout(t));
  } catch (err: any) {
    // Never let a broken webhook take down /health.
    logger.error({ err: err.message }, "alert webhook POST failed");
  }
}

// Minimum native balance (wei) below which /health reports degraded.
// EIP-3009 transferWithAuthorization costs ~55-70k gas. On RH testnet gas is
// ~0.01 gwei so 0.001 ETH is still ~1400 settlements of runway — a sane floor
// that avoids false-alarm 503s while still flagging a near-empty wallet.
// Override with MIN_GAS_BALANCE_WEI for mainnet where gas is far pricier.
const MIN_GAS_BALANCE_WEI = BigInt(process.env.MIN_GAS_BALANCE_WEI || "1000000000000000"); // 0.001 ETH
// Alert threshold — soft warning above the hard floor. Default 2x MIN.
const ALERT_GAS_BALANCE_WEI = BigInt(process.env.ALERT_GAS_BALANCE_WEI || (MIN_GAS_BALANCE_WEI * 2n).toString());

const app = express();

// Trust proxy: number of proxy hops in front of us. Behind Cloudflare→nginx
// that's 2, behind a single nginx it's 1, direct it's 0. Hardcoding 1 lets
// a spoofed X-Forwarded-For bypass the per-IP rate limiter when the real
// topology has 0 or 2 hops. Make it explicit via env (default 1).
const TRUST_PROXY_HOPS = parseInt(process.env.TRUST_PROXY_HOPS || "1");
app.set("trust proxy", TRUST_PROXY_HOPS);

// ── CORS allowlist ─────────────────────────────────────────────────────
// Only the demo-api origin(s) should be able to call /verify + /settle from
// a browser. Server-to-server calls (the actual resource server) don't send
// Origin and are unaffected. Comma-separated env; empty/unset = allow none
// (browsers get no ACAO header, non-browser callers still work).
const CORS_ALLOWLIST = (process.env.CORS_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ALLOWLIST.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});

app.use(httpLogger);
app.use(express.json({ limit: "16kb" }));

// ── Rate limiting ────────────────────────────────────────────────────
// /verify and /settle are the only endpoints that touch the chain or do
// signature-recovery crypto — both are worth protecting from flood/DoS.
// Settle is stricter since a successful flood there burns the facilitator's
// own gas balance.
//
// STORE SELECTION (single-instance vs multi-replica):
//   - Default: express-rate-limit's built-in in-memory store. Correct and
//     zero-dependency for a single-instance deploy (the current testnet
//     topology). Each replica would count independently, so N replicas =
//     N× the effective limit — fine when N=1.
//   - Multi-replica mainnet: set REDIS_URL and the limiter switches to a
//     shared Redis store so the limit is enforced across all replicas.
//     `rate-limit-redis` + `ioredis` are loaded lazily via dynamic import
//     so they are NOT hard build/runtime dependencies — a deploy without
//     Redis never pays for them and never fails to boot if they're absent.
//   - Fail-open by design: if REDIS_URL is set but the client can't connect,
//     we log an error and fall back to the in-memory store rather than
//     bringing the endpoint down. A degraded (per-replica) limit beats a
//     hard outage on a payments path.
// NOTE: synchronous by design. esbuild targets the CJS output format, which
// does not allow top-level await, so we resolve the store with `require()`
// (native in CJS) and run the connectivity probe as a fire-and-forget rather
// than awaiting it. ioredis connects lazily anyway — the client object is
// usable the moment it's constructed; the ping just surfaces a bad URL in the
// logs shortly after boot instead of on the first rate-limited request.
function makeRateLimitStore(): any | undefined {
  const url = process.env.REDIS_URL;
  if (!url) return undefined; // in-memory default
  try {
    // Lazy: these are optionalDependencies, required only when REDIS_URL is set.
    // Marked --external in the esbuild invocation so a Redis-less deploy neither
    // bundles nor needs them.
    // `require` typed as `any` here — these are optional peer deps with no
    // @types installed by default, and TS would otherwise demand type
    // declarations for a module that may not even be in node_modules.
    const req: any = require;
    const redisStoreMod = req("rate-limit-redis");
    const RedisStore = redisStoreMod.default ?? redisStoreMod;
    const ioredisMod = req("ioredis");
    const IORedis = ioredisMod.default ?? ioredisMod;
    const client = new IORedis(url, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    client.on("error", (err: Error) =>
      logger.error({ err: err.message }, "redis rate-limit store error"),
    );
    // Fire-and-forget probe so a bad URL surfaces in logs shortly after boot
    // rather than only on the first request. Does not block startup.
    client
      .ping()
      .then(() =>
        logger.info(
          { url: url.replace(/\/\/.*@/, "//***@") },
          "rate limiter using shared Redis store",
        ),
      )
      .catch((err: Error) =>
        logger.error({ err: err.message }, "redis ping failed (limiter still attached; will retry per request)"),
      );
    return new RedisStore({
      // rate-limit-redis calls the client's sendCommand.
      sendCommand: (...args: string[]) => (client as any).call(...args),
      prefix: "rl:hoodgate:",
    });
  } catch (err: any) {
    logger.error(
      { err: err?.message ?? String(err) },
      "failed to init Redis rate-limit store — falling back to in-memory (per-replica limits)",
    );
    return undefined;
  }
}

// Store is resolved once at boot. Both limiters share the same backing store
// choice; each keeps its own key namespace via rate-limit-redis prefix + the
// limiter's own key generator, so verify and settle counts never collide.
const rlStore = makeRateLimitStore();

const verifyLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60, // 1/sec sustained
  standardHeaders: true,
  legacyHeaders: false,
  ...(rlStore ? { store: rlStore } : {}),
  message: { isValid: false, invalidReason: "rate_limited" },
});
const settleLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20, // stricter — this one spends real gas
  standardHeaders: true,
  legacyHeaders: false,
  ...(rlStore ? { store: rlStore } : {}),
  message: { success: false, transaction: "", errorReason: "rate_limited" },
});

// ── Error taxonomy ───────────────────────────────────────────────────
// Never leak raw err.message (may contain RPC URLs, internal paths, viem
// internals) to callers. Map to a small stable enum instead; full detail
// stays server-side in the log.
type ErrorCode =
  | "malformed_request"
  | "invalid_address"
  | "rpc_unreachable"
  | "internal_error";

// viem throws typed errors for most invalid-input and network cases; we
// pattern-match on err.name (and a couple of message substrings for cases
// viem doesn't give a dedicated class for) to avoid leaking raw messages
// (RPC URLs, stack internals) to API callers while still giving them enough
// signal to know whether retrying or fixing their request makes sense.
function toErrorCode(err: any): ErrorCode {
  const name = err?.name || "";
  const msg = String(err?.message || err?.shortMessage || "");
  if (name === "TypeError" || name === "SyntaxError") return "malformed_request";
  if (name === "InvalidAddressError" || /invalid address|checksum/i.test(msg)) return "invalid_address";
  if (
    name === "TimeoutError" ||
    name === "HttpRequestError" ||
    /ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(msg)
  ) return "rpc_unreachable";
  return "internal_error";
}

// ── Health ──────────────────────────────────────────────────────────
// Two-layer status: gasBalanceOk is the *hard* liveness signal (below this
// the process cannot pay for a settlement and returns 503); gasBalanceWarn
// is the *soft* signal that fires the alert webhook once on threshold-cross
// so operators see it before customers do.
app.get("/health", async (_req, res) => {
  const checks: Record<string, any> = {
    address: account.address,
    chain: CHAIN_ID,
    uptimeSeconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
    settleCacheSize: settleCache.size,
  };
  let healthy = true;

  try {
    const balance = await publicClient.getBalance({ address: account.address });
    checks.gasBalanceWei = balance.toString();
    checks.gasBalanceOk = balance >= MIN_GAS_BALANCE_WEI;
    checks.gasBalanceWarn = balance < ALERT_GAS_BALANCE_WEI;
    if (!checks.gasBalanceOk) healthy = false;

    // Edge-triggered alert: fire only on state change to avoid spam.
    const newState: "ok" | "low" = checks.gasBalanceWarn ? "low" : "ok";
    if (newState !== alertState) {
      const msg = newState === "low"
        ? `⚠️ x402 facilitator gas low: ${balance} wei on chain ${CHAIN_ID} (signer ${account.address}). Threshold ${ALERT_GAS_BALANCE_WEI}. Top up soon.`
        : `✅ x402 facilitator gas recovered: ${balance} wei on chain ${CHAIN_ID} (signer ${account.address}).`;
      alertState = newState;
      void fireAlert(msg);
    }
  } catch (err: any) {
    checks.gasBalanceOk = false;
    checks.rpcError = "rpc_unreachable";
    healthy = false;
    logger.error({ err: err.message }, "health check: RPC balance read failed");
  }

  res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", ...checks });
});

// ── Supported schemes (x402 v2) ─────────────────────────────────────
app.get("/supported", (_req, res) => {
  res.json({
    kinds: [
      { x402Version: 2, scheme: "exact", network: `eip155:${CHAIN_ID}` },
    ],
    extensions: [],
    signers: {
      [`eip155:${CHAIN_ID}`]: [account.address],
    },
  });
});

// ── Verify (x402 v2: {x402Version, paymentPayload, paymentRequirements}) ──
app.post("/verify", verifyLimiter, async (req, res) => {
  const started = Date.now();
  try {
    // v2 naming, with legacy {payload, requirements} tolerance
    const paymentPayload = req.body.paymentPayload ?? req.body.payload;
    // Requirements: explicit param → payload.accepted (v2 canonical) → undefined
    const paymentRequirements = req.body.paymentRequirements ?? req.body.requirements ?? paymentPayload?.accepted;
    const result = await verifyPayment(publicClient, paymentPayload, paymentRequirements);
    req.log.info({ isValid: result.isValid, invalidReason: result.invalidReason, payer: result.payer }, "verify");
    inc("facilitator_verify_total", { outcome: result.isValid ? "valid" : "invalid", reason: result.invalidReason || "ok" });
    res.json(result);
  } catch (err: any) {
    req.log.error({ err: err.message, stack: err.stack }, "verify: unhandled error");
    const code = toErrorCode(err);
    inc("facilitator_verify_total", { outcome: "error", reason: code });
    res.status(400).json({ isValid: false, invalidReason: code });
  } finally {
    observe("verify", Date.now() - started);
  }
});

// ── Settle (x402 v2) ────────────────────────────────────────────────
app.post("/settle", settleLimiter, async (req, res) => {
  const started = Date.now();
  try {
    const paymentPayload = req.body.paymentPayload ?? req.body.payload;
    const paymentRequirements = req.body.paymentRequirements ?? req.body.requirements ?? paymentPayload?.accepted;

    // Idempotency key: signer + nonce is unique per authorization by EIP-3009
    // definition. If we already settled it, return the cached result. If a
    // sibling request is mid-flight, coalesce onto its result instead of
    // broadcasting a second tx.
    const inner = paymentPayload?.payload ?? paymentPayload;
    const auth = inner?.authorization ?? inner;
    const cacheKey = auth?.from && auth?.nonce
      ? `${String(auth.from).toLowerCase()}:${String(auth.nonce).toLowerCase()}`
      : null;

    if (cacheKey) {
      const entry = settleCache.get(cacheKey);
      if (entry?.status === "done") {
        req.log.info({ cacheKey }, "settle: idempotent replay served from cache");
        return res.json(entry.result);
      }
      if (entry?.status === "pending") {
        // In-flight duplicate. Fail fast — client should retry after a moment.
        req.log.info({ cacheKey }, "settle: duplicate in-flight, rejecting");
        inc("facilitator_settle_total", { outcome: "duplicate", reason: "settlement_in_flight" });
        return res.status(409).json({
          success: false, transaction: "", network: `eip155:${CHAIN_ID}`,
          errorReason: "settlement_in_flight",
        });
      }
      settleCache.set(cacheKey, { status: "pending" });
    }

    let result: any;
    try {
      result = await settlePayment(walletClient, publicClient, paymentPayload, paymentRequirements);
    } finally {
      // Cache both success AND failure — failures aren't retriable with the
      // same nonce anyway (either signature was bad or the nonce is now
      // consumed on-chain), and caching them protects against retry-storm.
      if (cacheKey) {
        settleCache.set(cacheKey, {
          status: "done",
          result,
          expiresAt: Date.now() + SETTLE_CACHE_TTL_MS,
        });
      }
    }

    req.log.info({ success: result.success, transaction: result.transaction, payer: result.payer, errorReason: result.errorReason }, "settle");
    inc("facilitator_settle_total", { outcome: result.success ? "success" : "failure", reason: result.errorReason || "ok" });
    res.json(result);
  } catch (err: any) {
    req.log.error({ err: err.message, stack: err.stack }, "settle: unhandled error");
    const code = toErrorCode(err);
    inc("facilitator_settle_total", { outcome: "error", reason: code });
    res.status(400).json({ success: false, transaction: "", network: `eip155:${CHAIN_ID}`, errorReason: code });
  } finally {
    observe("settle", Date.now() - started);
  }
});

// ── Metrics (Prometheus text exposition) ────────────────────────────
// Scrape target for prometheus / grafana agent. No auth here on purpose —
// bind to localhost / behind nginx in prod (see ops runbook).
app.get("/metrics", (_req, res) => {
  const lines: string[] = [];
  lines.push("# HELP facilitator_up 1 if the process is running");
  lines.push("# TYPE facilitator_up gauge");
  lines.push("facilitator_up 1");
  lines.push("# HELP facilitator_uptime_seconds Seconds since process start");
  lines.push("# TYPE facilitator_uptime_seconds gauge");
  lines.push(`facilitator_uptime_seconds ${Math.floor((Date.now() - metrics.startedAt) / 1000)}`);
  lines.push("# HELP facilitator_settle_cache_size Current /settle idempotency-cache entries");
  lines.push("# TYPE facilitator_settle_cache_size gauge");
  lines.push(`facilitator_settle_cache_size ${settleCache.size}`);

  // Counter groups
  const groups = new Map<string, string[]>();
  for (const [k, v] of metrics.counters) {
    const name = k.split("{")[0];
    const arr = groups.get(name) || [];
    arr.push(`${k} ${v}`);
    groups.set(name, arr);
  }
  for (const [name, samples] of groups) {
    lines.push(`# HELP ${name} Cumulative counter`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(...samples);
  }

  // Latency summaries
  for (const [route, samples] of metrics.latency) {
    const sorted = [...samples].sort((a, b) => a - b);
    const metric = `facilitator_${route}_latency_ms`;
    lines.push(`# HELP ${metric} Recent-window latency for /${route} (ms, last <=1000 samples)`);
    lines.push(`# TYPE ${metric} summary`);
    lines.push(`${metric}{quantile="0.5"} ${percentile(sorted, 50)}`);
    lines.push(`${metric}{quantile="0.9"} ${percentile(sorted, 90)}`);
    lines.push(`${metric}{quantile="0.99"} ${percentile(sorted, 99)}`);
    lines.push(`${metric}_count ${sorted.length}`);
  }

  res.setHeader("Content-Type", "text/plain; version=0.0.4");
  res.send(lines.join("\n") + "\n");
});

// ── Startup contract validation (fix C2) ────────────────────────────
// Confirm the configured USDG address is actually a deployed contract on
// this chain (has bytecode) and exposes EIP-3009 authorizationState. This
// catches the classic footgun of pointing at the wrong address / wrong
// chain / an EOA — which would otherwise fail opaquely at first settle.
// Non-fatal by default (testnet convenience); set STRICT_TOKEN_CHECK=1 to
// refuse boot on failure (recommended for mainnet).
const USDG_ADDRESS = (process.env.MOCK_USDG_ADDRESS || "0xdDC7e17D6c06F8c5126b65fc9164481D87e6edE4") as `0x${string}`;
const STRICT_TOKEN_CHECK = process.env.STRICT_TOKEN_CHECK === "1";

async function validateTokenContract(): Promise<void> {
  try {
    const code = await publicClient.getCode({ address: USDG_ADDRESS });
    if (!code || code === "0x") {
      const msg = `Configured USDG address ${USDG_ADDRESS} has no bytecode on chain ${CHAIN_ID} — wrong address or wrong chain?`;
      if (STRICT_TOKEN_CHECK) {
        logger.fatal(msg);
        process.exit(1);
      }
      logger.warn(msg + " (continuing; set STRICT_TOKEN_CHECK=1 to make this fatal)");
      return;
    }
    // Probe authorizationState(0x0, 0x0) — a view call that only succeeds if
    // the EIP-3009 selector exists. We don't care about the result, just that
    // it doesn't revert with "function not found".
    await publicClient.readContract({
      address: USDG_ADDRESS,
      abi: [{ inputs: [{ name: "a", type: "address" }, { name: "n", type: "bytes32" }], name: "authorizationState", outputs: [{ name: "", type: "bool" }], stateMutability: "view", type: "function" }],
      functionName: "authorizationState",
      args: ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000000000000000000000000000"],
    });
    logger.info(`USDG contract OK at ${USDG_ADDRESS} (bytecode present, EIP-3009 authorizationState callable)`);
  } catch (err: any) {
    const msg = `USDG contract validation failed at ${USDG_ADDRESS}: ${err.shortMessage || err.message}`;
    if (STRICT_TOKEN_CHECK) {
      logger.fatal(msg);
      process.exit(1);
    }
    logger.warn(msg + " (continuing; set STRICT_TOKEN_CHECK=1 to make this fatal)");
  }
}

const server = app.listen(PORT, () => {
  logger.info(`Robinhood x402 Facilitator running on :${PORT}`);
  logger.info(`Chain: ${CHAIN_ID} | RPC: ${RH_RPC}`);
  logger.info(`Signer: ${account.address}`);
  logger.info(`Trust proxy hops: ${TRUST_PROXY_HOPS} | CORS origins: ${CORS_ALLOWLIST.length ? CORS_ALLOWLIST.join(", ") : "(none)"}`);
  void validateTokenContract();
});

// ── Graceful shutdown ────────────────────────────────────────────────
// On SIGTERM/SIGINT: stop accepting new connections, let in-flight
// verify/settle requests finish (settle in particular must not be cut
// mid-broadcast — that leaves a client with a burned nonce and no
// transaction hash), then exit.
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, draining in-flight requests before exit`);
  server.close(() => {
    logger.info("all connections drained, exiting");
    process.exit(0);
  });
  // Hard exit if drain takes too long (e.g. a hung RPC call).
  setTimeout(() => {
    logger.warn("graceful shutdown timed out after 15s, forcing exit");
    process.exit(1);
  }, 15_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
