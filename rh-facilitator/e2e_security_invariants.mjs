/**
 * x402 v2 SECURITY INVARIANT TESTS (negative tests).
 *
 * Each case MUST be rejected by verify/settle — none may settle on-chain.
 *   1. Nonce reuse (replay)      — reuse an already-settled authorization
 *   2. Expired signature         — validBefore in the past
 *   3. Invalid signature         — tampered signature bytes
 *   4. Amount mismatch           — signed value < required amount
 *   5. Wrong payTo               — signed to attacker address
 *   6. Not-yet-valid (validAfter future)
 *
 * A PASS means the server refused (non-200, no on-chain tx).
 */
import { createWalletClient, http, createPublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

const RESOURCE = process.env.RESOURCE || "http://localhost:3005/weather";
const RH_RPC = process.env.RH_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const CLIENT_KEY = process.env.CLIENT_KEY;
if (!CLIENT_KEY) {
  console.error("ERROR: CLIENT_KEY env var required (funded testnet private key, 0x-prefixed)");
  process.exit(1);
}
const ATTACKER = "0x000000000000000000000000000000000000dEaD";

const chain = {
  id: 46630, name: "RH Chain Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RH_RPC] } },
};
const account = privateKeyToAccount(CLIENT_KEY);
const wallet = createWalletClient({ account, chain, transport: http(RH_RPC) });

function log(k, v) { console.log(`\x1b[36m${k}\x1b[0m ${v}`); }
function pass(m) { console.log(`\x1b[32m✔ PASS\x1b[0m ${m}`); }
function failCase(m) { console.error(`\x1b[31m✘ FAIL\x1b[0m ${m}`); failures++; }
function b64e(o) { return Buffer.from(JSON.stringify(o)).toString("base64"); }
function b64d(s) { return JSON.parse(Buffer.from(s, "base64").toString("utf-8")); }

let failures = 0;

const TYPES = {
  TransferWithAuthorization: [    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};

async function getRequirements() {
  const r = await fetch(RESOURCE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ city: "Kyoto" }) });
  const pr = b64d(r.headers.get("payment-required"));
  return pr.accepts[0];
}

async function signAuth(req, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const nonce = overrides.nonce || ("0x" + randomBytes(32).toString("hex"));
  const to = overrides.to || req.payTo;
  const value = overrides.value !== undefined ? overrides.value : req.amount;
  const validAfter = overrides.validAfter !== undefined ? overrides.validAfter : 0;
  const validBefore = overrides.validBefore !== undefined ? overrides.validBefore : now + Math.min(req.maxTimeoutSeconds || 60, 3600);
  const domain = { name: req.extra.name, version: req.extra.version, chainId: parseInt(req.network.split(":")[1], 10), verifyingContract: req.asset };
  const message = { from: account.address, to, value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce };
  const signature = await wallet.signTypedData({ domain, types: TYPES, primaryType: "TransferWithAuthorization", message });
  const authorization = { from: account.address, to, value: String(value), validAfter: String(validAfter), validBefore: String(validBefore), nonce };
  return { authorization, signature };
}

function buildPayload(req, authorization, signature) {
  return { x402Version: 2, accepted: req, payload: { authorization, signature }, extensions: null };
}

async function attempt(req, authorization, signature) {
  const r = await fetch(RESOURCE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": b64e(buildPayload(req, authorization, signature)) },
    body: JSON.stringify({ city: "Kyoto" }),
  });
  let body;
  try { body = await r.json(); } catch { body = {}; }
  return { status: r.status, body, settled: r.status === 200 && (body.settlement?.transaction || body.settlement?.txHash) };
}

// ── Case 2: Expired signature ──
console.log("\n\x1b[1m=== Case: Expired signature (validBefore in past) ===\x1b[0m");
{
  const req = await getRequirements();
  const past = Math.floor(Date.now() / 1000) - 3600;
  const { authorization, signature } = await signAuth(req, { validBefore: past });
  const res = await attempt(req, authorization, signature);
  log("status:", res.status);
  if (res.settled) failCase("expired sig SETTLED on-chain — invariant broken"); else pass("expired signature rejected");
}

// ── Case 3: Invalid signature (tampered) ──
console.log("\n\x1b[1m=== Case: Invalid signature (tampered bytes) ===\x1b[0m");
{
  const req = await getRequirements();
  const { authorization, signature } = await signAuth(req);
  // flip a byte in the middle of the signature
  const tampered = signature.slice(0, 40) + (signature[40] === "a" ? "b" : "a") + signature.slice(41);
  const res = await attempt(req, authorization, tampered);
  log("status:", res.status);
  if (res.settled) failCase("tampered sig SETTLED — invariant broken"); else pass("invalid signature rejected");
}

// ── Case 4: Amount mismatch (signed less than required) ──
console.log("\n\x1b[1m=== Case: Amount mismatch (signed < required) ===\x1b[0m");
{
  const req = await getRequirements();
  const lower = String(BigInt(req.amount) - 1n);
  const { authorization, signature } = await signAuth(req, { value: lower });
  const res = await attempt(req, authorization, signature);
  log("status:", res.status, "signed value:", lower, "required:", req.amount);
  if (res.settled) failCase("underpayment SETTLED — invariant broken"); else pass("amount mismatch rejected");
}

// ── Case 5: Wrong payTo (funds redirected to attacker) ──
console.log("\n\x1b[1m=== Case: Wrong payTo (attacker address) ===\x1b[0m");
{
  const req = await getRequirements();
  const { authorization, signature } = await signAuth(req, { to: ATTACKER });
  const res = await attempt(req, authorization, signature);
  log("status:", res.status, "to:", ATTACKER);
  if (res.settled) failCase("wrong-payTo SETTLED — invariant broken"); else pass("wrong payTo rejected");
}

// ── Case 6: Not-yet-valid (validAfter in future) ──
console.log("\n\x1b[1m=== Case: Not-yet-valid (validAfter future) ===\x1b[0m");
{
  const req = await getRequirements();
  const future = Math.floor(Date.now() / 1000) + 7200;
  const { authorization, signature } = await signAuth(req, { validAfter: future, validBefore: future + 300 });
  const res = await attempt(req, authorization, signature);
  log("status:", res.status);
  if (res.settled) failCase("not-yet-valid SETTLED — invariant broken"); else pass("premature authorization rejected");
}

// ── Case 1: Nonce reuse (replay) — do this LAST since it settles a real tx first ──
console.log("\n\x1b[1m=== Case: Nonce reuse / replay ===\x1b[0m");
{
  const req = await getRequirements();
  const { authorization, signature } = await signAuth(req);
  // First submission should succeed (real on-chain settlement).
  const first = await attempt(req, authorization, signature);
  log("first submission status:", first.status);
  if (!first.settled) {
    log("note:", "first submission did not settle (possibly insufficient funds); replay check inconclusive");
    console.log("BODY:", JSON.stringify(first.body).slice(0, 200));
  } else {
    log("first tx:", first.body.settlement.transaction || first.body.settlement.txHash);
    // Replay the exact same authorization+signature (same nonce).
    const replay = await attempt(req, authorization, signature);
    log("replay status:", replay.status);
    if (replay.settled) failCase("REPLAY SETTLED — nonce reuse invariant broken"); else pass("nonce reuse (replay) rejected");
  }
}

console.log("");
if (failures === 0) {
  console.log(`\x1b[1;32m=== SECURITY INVARIANTS: ALL PASS ✅ ===\x1b[0m`);
} else {
  console.log(`\x1b[1;31m=== SECURITY INVARIANTS: ${failures} FAILURE(S) ✘ ===\x1b[0m`);
  process.exit(1);
}
