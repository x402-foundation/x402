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

const publicClient = createPublicClient({
  chain: robinhoodTestnet,
  transport: http(RH_RPC),
});

const walletClient = createWalletClient({
  account,
  chain: robinhoodTestnet,
  transport: http(RH_RPC),
});

// Minimum native balance (wei) below which /health reports degraded.
// EIP-3009 transferWithAuthorization costs ~55-70k gas. On RH testnet gas is
// ~0.01 gwei so 0.001 ETH is still ~1400 settlements of runway — a sane floor
// that avoids false-alarm 503s while still flagging a near-empty wallet.
// Override with MIN_GAS_BALANCE_WEI for mainnet where gas is far pricier.
const MIN_GAS_BALANCE_WEI = BigInt(process.env.MIN_GAS_BALANCE_WEI || "1000000000000000"); // 0.001 ETH

const app = express();
app.set("trust proxy", 1); // needed for correct req.ip behind a reverse proxy / tunnel
app.use(httpLogger);
app.use(express.json());

// ── Rate limiting ────────────────────────────────────────────────────
// /verify and /settle are the only endpoints that touch the chain or do
// signature-recovery crypto — both are worth protecting from flood/DoS.
// Settle is stricter since a successful flood there burns the facilitator's
// own gas balance.
const verifyLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60, // 1/sec sustained
  standardHeaders: true,
  legacyHeaders: false,
  message: { isValid: false, invalidReason: "rate_limited" },
});
const settleLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20, // stricter — this one spends real gas
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, transaction: "", errorReason: "rate_limited" },
});

// ── Error taxonomy ───────────────────────────────────────────────────
// Never leak raw err.message (may contain RPC URLs, internal paths, viem
// internals) to callers. Map to a small stable enum instead; full detail
// stays server-side in the log.
type ErrorCode =
  | "malformed_request"
  | "internal_error";

function toErrorCode(err: any): ErrorCode {
  // Reserved for future refinement (e.g. distinguishing validation vs
  // unexpected errors by type). Currently verifyPayment/settlePayment
  // already return typed invalidReason/errorReason for domain errors;
  // anything that throws past that layer is treated as internal.
  return err?.name === "TypeError" || err?.name === "SyntaxError"
    ? "malformed_request"
    : "internal_error";
}

// ── Health ──────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  const checks: Record<string, any> = { address: account.address, chain: CHAIN_ID };
  let healthy = true;

  try {
    const balance = await publicClient.getBalance({ address: account.address });
    checks.gasBalanceWei = balance.toString();
    checks.gasBalanceOk = balance >= MIN_GAS_BALANCE_WEI;
    if (!checks.gasBalanceOk) healthy = false;
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
  try {
    // v2 naming, with legacy {payload, requirements} tolerance
    const paymentPayload = req.body.paymentPayload ?? req.body.payload;
    // Requirements: explicit param → payload.accepted (v2 canonical) → undefined
    const paymentRequirements = req.body.paymentRequirements ?? req.body.requirements ?? paymentPayload?.accepted;
    const result = await verifyPayment(publicClient, paymentPayload, paymentRequirements);
    req.log.info({ isValid: result.isValid, invalidReason: result.invalidReason, payer: result.payer }, "verify");
    res.json(result);
  } catch (err: any) {
    req.log.error({ err: err.message, stack: err.stack }, "verify: unhandled error");
    res.status(400).json({ isValid: false, invalidReason: toErrorCode(err) });
  }
});

// ── Settle (x402 v2) ────────────────────────────────────────────────
app.post("/settle", settleLimiter, async (req, res) => {
  try {
    const paymentPayload = req.body.paymentPayload ?? req.body.payload;
    const paymentRequirements = req.body.paymentRequirements ?? req.body.requirements ?? paymentPayload?.accepted;
    const result = await settlePayment(walletClient, publicClient, paymentPayload, paymentRequirements);
    req.log.info({ success: result.success, transaction: result.transaction, payer: result.payer, errorReason: result.errorReason }, "settle");
    res.json(result);
  } catch (err: any) {
    req.log.error({ err: err.message, stack: err.stack }, "settle: unhandled error");
    res.status(400).json({ success: false, transaction: "", network: `eip155:${CHAIN_ID}`, errorReason: toErrorCode(err) });
  }
});

const server = app.listen(PORT, () => {
  logger.info(`Robinhood x402 Facilitator running on :${PORT}`);
  logger.info(`Chain: ${CHAIN_ID} | RPC: ${RH_RPC}`);
  logger.info(`Signer: ${account.address}`);
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
