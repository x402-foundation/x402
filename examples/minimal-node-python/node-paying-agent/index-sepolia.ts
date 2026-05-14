/**
 * x402 Node.js Paying Agent — Base Sepolia real on-chain settlement
 *
 * Uses USDC's native EIP-3009 transferWithAuthorization — no escrow contract needed.
 * The paying agent signs two things:
 *   1. The x402Grant (EIP-712, as in the local example)
 *   2. A USDC transferWithAuthorization (EIP-712, authorizes the receiving agent to pull funds)
 *
 * The receiving agent submits the USDC transfer on-chain and returns a receipt
 * with the real Base Sepolia tx hash.
 *
 * Run: npm run start:sepolia
 * Prereqs: .env with PRIVATE_KEY + USDC_ADDRESS + BASE_SEPOLIA_RPC + RECEIVING_AGENT_ADDRESS
 */

import { ethers } from "ethers";
import fetch      from "node-fetch";
import { signGrant } from "./grants.js";
import type { x402Grant } from "./grants.js";
import * as dotenv from "dotenv";
dotenv.config({ path: "../.env" });

// ── Config ────────────────────────────────────────────────────────────────────
const RPC_URL          = process.env.BASE_SEPOLIA_RPC  ?? "https://sepolia.base.org";
const PRIVATE_KEY      = process.env.PRIVATE_KEY       ?? "";
const USDC_ADDRESS     = process.env.USDC_ADDRESS      ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const AGENT_ADDRESS    = process.env.RECEIVING_AGENT_ADDRESS ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const RECEIVER_URL     = "http://localhost:3000/api/tool";
const CHAIN_ID         = 84532; // Base Sepolia
const PAYMENT_AMOUNT   = 5_000_000n; // 5 USDC (6 decimals)

if (!PRIVATE_KEY) {
  console.error("❌  Set PRIVATE_KEY in examples/minimal-node-python/.env");
  process.exit(1);
}

// ── Minimal USDC ABI (only what we need) ─────────────────────────────────────
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function nonces(address) view returns (bytes32)",
];

// ── EIP-3009 domain + types (USDC on Base Sepolia) ────────────────────────────
// USDC uses its own EIP-712 domain for transferWithAuthorization
const USDC_DOMAIN = {
  name:              "USD Coin",
  version:           "2",
  chainId:           CHAIN_ID,
  verifyingContract: USDC_ADDRESS,
};

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
  ],
};

async function signEip3009Transfer(
  signer:      ethers.Wallet,
  to:          string,
  value:       bigint,
  validBefore: number,
  nonce:       string,
): Promise<{ from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string; signature: string }> {
  const data = {
    from:        signer.address,
    to,
    value,
    validAfter:  0n,
    validBefore: BigInt(validBefore),
    nonce,
  };
  const signature = await signer.signTypedData(USDC_DOMAIN, TRANSFER_WITH_AUTHORIZATION_TYPES, data);
  return {
    from:        signer.address,
    to,
    value:       value.toString(),
    validAfter:  "0",
    validBefore: validBefore.toString(),
    nonce,
    signature,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Connecting to Base Sepolia (${RPC_URL})...`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const usdc     = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);

  // Check balance
  const balance: bigint = await usdc.balanceOf(wallet.address);
  const formatted       = (Number(balance) / 1e6).toFixed(6);
  console.log(`Wallet: ${wallet.address}`);
  console.log(`USDC balance: ${formatted} USDC`);

  if (balance < PAYMENT_AMOUNT) {
    console.error(`❌  Insufficient USDC. Need at least 5.000000, have ${formatted}`);
    console.error(`    Get test USDC at: https://faucet.circle.com (select Base Sepolia)`);
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);

  // ── 1. Sign the x402 Grant ────────────────────────────────────────────────
  const grant: x402Grant = {
    grantId:       1n,
    principal:     wallet.address,
    agent:         AGENT_ADDRESS,
    issuedAt:      BigInt(now),
    expiration:    BigInt(now + 900), // 15-minute TTL
    totalBudget:   1_000_000_000n,   // 1000 USDC total budget
    perRequestCap: PAYMENT_AMOUNT,   //    5 USDC per call
    scopes:        ["0x8f3a8c9b2d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a"],
    salt:          ethers.id("x402-sepolia-" + now),
  };

  // Grant domain uses CHAIN_ID 84532 (Base Sepolia) for real deployment
  const grantSig = await signGrant(wallet, grant);
  console.log(`Grant signed: ${grantSig.slice(0, 20)}...`);

  // ── 2. Sign the EIP-3009 USDC transfer authorization ─────────────────────
  const nonce       = ethers.hexlify(ethers.randomBytes(32));
  const validBefore = now + 300; // 5-minute window for the receiving agent to submit

  const eip3009Auth = await signEip3009Transfer(
    wallet,
    AGENT_ADDRESS,
    PAYMENT_AMOUNT,
    validBefore,
    nonce,
  );
  console.log(`EIP-3009 transferWithAuthorization signature: ${eip3009Auth.signature.slice(0, 20)}...`);

  // ── 3. Build receiptHash (replay protection) ──────────────────────────────
  const requestBody  = JSON.stringify({ tool: "sepolia-example-tool", params: { query: "real settlement" } });
  const receiptHash  = ethers.keccak256(ethers.toUtf8Bytes(requestBody));

  // ── 4. Serialize for HTTP transport ──────────────────────────────────────
  const grantPayload = {
    grantId:       grant.grantId.toString(),
    principal:     grant.principal,
    agent:         grant.agent,
    issuedAt:      Number(grant.issuedAt),
    expiration:    Number(grant.expiration),
    totalBudget:   grant.totalBudget.toString(),
    perRequestCap: grant.perRequestCap.toString(),
    scopes:        grant.scopes,
    salt:          grant.salt,
  };

  const paymentHeader = Buffer.from(JSON.stringify({
    grant:       grantPayload,
    signature:   grantSig,
    eip3009Auth,
    receiptHash,
    network:     `eip155:${CHAIN_ID}`,
    asset:       USDC_ADDRESS,
  })).toString("base64");

  console.log(`\nSending x402 request to ${RECEIVER_URL}...`);
  const t0 = Date.now();

  const res = await fetch(RECEIVER_URL, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "X-402-Payment": paymentHeader,
    },
    body: requestBody,
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`HTTP ${res.status} received (${elapsed}s)`);

  if (res.status === 200) {
    const receiptB64 = res.headers.get("x-402-receipt");
    if (receiptB64) {
      const receipt = JSON.parse(Buffer.from(receiptB64, "base64").toString());
      console.log("\nX-402-Receipt:");
      console.log(JSON.stringify(receipt, null, 2));
      if (receipt.txHash && !receipt.txHash.startsWith("0x1234")) {
        console.log(`\nView on explorer: https://sepolia.basescan.org/tx/${receipt.txHash}`);
      }
    }
    const body = await res.json().catch(() => ({}));
    console.log("Response:", body);
    console.log("\nFull cycle complete. ✅");
  } else if (res.status === 402) {
    const refundB64 = res.headers.get("x-402-refund");
    const refund    = refundB64
      ? JSON.parse(Buffer.from(refundB64, "base64").toString())
      : await res.json().catch(() => null);
    console.error("❌  Payment failed:", refund);
  } else {
    console.error(`❌  Unexpected ${res.status}:`, await res.text());
  }
}

main().catch(console.error);
