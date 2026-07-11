/**
 * x402 v2 CONFORMANCE TEST — matches @x402/fetch@2.17.0 wire format exactly.
 *
 * Verifies:
 *  - Server emits PAYMENT-REQUIRED header (base64 JSON) alongside JSON body
 *  - Client sends PAYMENT-SIGNATURE header (base64 v2 PaymentPayload)
 *  - PaymentPayload has {x402Version, accepted, payload:{authorization, signature}, extensions}
 *  - Server emits PAYMENT-RESPONSE header
 *  - EIP-712 domain derived from requirements.extra.name/version
 *  - On-chain settlement succeeds
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

const chain = {
  id: 46630, name: "RH Chain Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RH_RPC] } },
};
const account = privateKeyToAccount(CLIENT_KEY);
const wallet = createWalletClient({ account, chain, transport: http(RH_RPC) });
const pub = createPublicClient({ chain, transport: http(RH_RPC) });

function log(k, v) { console.log(`\x1b[36m${k}\x1b[0m ${v}`); }
function ok(m) { console.log(`\x1b[32m✔\x1b[0m ${m}`); }
function fail(m) { console.error(`\x1b[31m✘\x1b[0m ${m}`); process.exit(1); }
function b64e(o) { return Buffer.from(JSON.stringify(o)).toString("base64"); }
function b64d(s) { return JSON.parse(Buffer.from(s, "base64").toString("utf-8")); }

// ── Step 1: 402 challenge — must have PAYMENT-REQUIRED header AND body ──
console.log("\n\x1b[1m=== Step 1: 402 challenge (v2 wire format) ===\x1b[0m");
const r1 = await fetch(RESOURCE, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ city: "Osaka" }),
});
if (r1.status !== 402) fail(`expected 402, got ${r1.status}`);

const prHeader = r1.headers.get("payment-required");
if (!prHeader) fail("PAYMENT-REQUIRED header missing (v2 spec requires it)");
const prFromHeader = b64d(prHeader);
log("PAYMENT-REQUIRED header decoded:", `x402Version=${prFromHeader.x402Version} accepts=${prFromHeader.accepts?.length}`);
if (prFromHeader.x402Version !== 2) fail("header x402Version must be 2");
if (!Array.isArray(prFromHeader.accepts) || prFromHeader.accepts.length === 0) fail("accepts array missing/empty");

const prFromBody = await r1.json();
if (prFromBody.x402Version !== 2) fail("body x402Version must be 2");
ok("both PAYMENT-REQUIRED header AND JSON body present, both v2");

const req = prFromHeader.accepts[0];
log("requirements:", JSON.stringify(req));

// Field shape assertions per SDK canonical PaymentRequirements
for (const f of ["scheme","network","amount","asset","payTo","maxTimeoutSeconds","resource","description","mimeType","extra"]) {
  if (!(f in req)) fail(`requirements.${f} missing`);
}
if (typeof req.resource !== "string" || !req.resource.startsWith("http")) fail("resource must be top-level URL string");
if (!req.extra.name || !req.extra.version) fail("extra.name/version required for EIP-712 domain");
ok("PaymentRequirements canonical shape verified");

// ── Step 2: EIP-3009 sign using domain from requirements.extra ──
console.log("\n\x1b[1m=== Step 2: EIP-3009 sign (domain from extra) ===\x1b[0m");
const now = Math.floor(Date.now() / 1000);
const nonce = "0x" + randomBytes(32).toString("hex");
const chainIdFromNet = parseInt(req.network.split(":")[1], 10);

const domain = {
  name: req.extra.name,
  version: req.extra.version,
  chainId: chainIdFromNet,
  verifyingContract: req.asset,
};
log("EIP-712 domain:", JSON.stringify(domain));

const types = {
  TransferWithAuthorization: [    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};
const validBefore = now + Math.min(req.maxTimeoutSeconds || 60, 3600);
const message = {
  from: account.address, to: req.payTo, value: BigInt(req.amount),
  validAfter: 0n, validBefore: BigInt(validBefore), nonce,
};
const signature = await wallet.signTypedData({ domain, types, primaryType: "TransferWithAuthorization", message });
log("signature:", signature.slice(0, 30) + "...");
ok("EIP-3009 signed via extra-derived domain");

// ── Step 3: build canonical v2 PaymentPayload ──
console.log("\n\x1b[1m=== Step 3: v2 PaymentPayload {accepted, payload{authorization, signature}} ===\x1b[0m");
const authorization = {
  from: account.address, to: req.payTo, value: req.amount,
  validAfter: "0", validBefore: String(validBefore), nonce,
};
const paymentPayload = {
  x402Version: 2,
  accepted: req,                                // full requirements object
  payload: { authorization, signature },        // nested (SDK canonical shape)
  extensions: null,
};
const paySigHeader = b64e(paymentPayload);
log("PAYMENT-SIGNATURE length:", paySigHeader.length);
ok("PaymentPayload built");

// ── Step 4: retry with PAYMENT-SIGNATURE ──
console.log("\n\x1b[1m=== Step 4: retry with PAYMENT-SIGNATURE ===\x1b[0m");
const r2 = await fetch(RESOURCE, {
  method: "POST",
  headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySigHeader },
  body: JSON.stringify({ city: "Osaka" }),
});
log("HTTP:", r2.status);
if (r2.status !== 200) {
  const debug = await r2.text();
  console.error("BODY:", debug);
  fail(`retry returned ${r2.status}`);
}

// Server MUST emit PAYMENT-RESPONSE header per v2 spec.
const respHeader = r2.headers.get("payment-response");
if (!respHeader) fail("PAYMENT-RESPONSE header missing (v2 spec requires it)");
const settlement = b64d(respHeader);
log("PAYMENT-RESPONSE decoded:", JSON.stringify(settlement));
ok("PAYMENT-RESPONSE header present and decodable");

const body = await r2.json();
log("weather:", `${body.city} / ${body.temp_f}°F / ${body.condition}`);
log("tx hash:", settlement.transaction);

if (!settlement.success) fail("settlement.success is false");
if (!settlement.transaction?.startsWith("0x")) fail("transaction hash missing");
if (settlement.payer.toLowerCase() !== account.address.toLowerCase()) fail("payer mismatch");
ok("settlement structurally valid");

// ── Step 5: on-chain confirm ──
console.log("\n\x1b[1m=== Step 5: on-chain confirmation ===\x1b[0m");
const receipt = await pub.waitForTransactionReceipt({ hash: settlement.transaction, timeout: 30000 });
log("block:", receipt.blockNumber.toString());
log("status:", receipt.status);
if (receipt.status !== "success") fail(`tx status: ${receipt.status}`);
ok(`tx confirmed in block ${receipt.blockNumber}`);

console.log(`\n\x1b[1;32m=== FASE 2 CONFORMANCE: PASS ✅ ===\x1b[0m`);
console.log(`Wire format: canonical @x402/fetch@2.17.0`);
console.log(`Tx: ${settlement.transaction}`);
console.log(`Explorer: https://explorer.testnet.chain.robinhood.com/tx/${settlement.transaction}`);
