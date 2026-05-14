/**
 * x402 Node.js Paying Agent — reference implementation
 *
 * Sends a signed x402 grant to the Python receiving agent and prints the receipt.
 * Uses the Hardhat test key from specs/test-vectors.json — swap for a real key in production.
 */
import { ethers }    from "ethers";
import fetch         from "node-fetch";
import { signGrant } from "./grants.js";
import type { x402Grant } from "./grants.js";

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const AGENT_ADDRESS    = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // Hardhat account #1
const RECEIVER_URL     = "http://localhost:3000/api/tool";

async function main() {
  const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);
  const now    = Math.floor(Date.now() / 1000);

  // Build the grant
  const grant: x402Grant = {
    grantId:       1n,
    principal:     wallet.address,   // 0xf39Fd...2266
    agent:         AGENT_ADDRESS,
    issuedAt:      BigInt(now),
    expiration:    BigInt(now + 900), // 15-minute TTL
    totalBudget:   1_000_000_000n,   // 1000 USDC (6 decimals)
    perRequestCap: 5_000_000n,       //    5 USDC per call
    scopes:        ["0x8f3a8c9b2d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a"],
    salt:          ethers.id("x402-example-" + now),
  };

  console.log("Signing grant with principal:", wallet.address);
  const signature = await signGrant(wallet, grant);
  console.log("Grant signed:", signature.slice(0, 18) + "...");

  // Build receiptHash = keccak256 of request body (replay protection)
  const requestBody  = JSON.stringify({ tool: "example-tool", params: { query: "hello" } });
  const receiptHash  = ethers.keccak256(ethers.toUtf8Bytes(requestBody));

  // Serialize grant for HTTP transport (BigInt → string)
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
    signature,
    receiptHash,
  })).toString("base64");

  console.log("\nPaying agent sending x402 request to", RECEIVER_URL);

  const res = await fetch(RECEIVER_URL, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "X-402-Payment": paymentHeader,
    },
    body: requestBody,
  });

  console.log(`HTTP ${res.status} received`);

  if (res.status === 200) {
    const receiptB64 = res.headers.get("x-402-receipt");
    if (receiptB64) {
      const receipt = JSON.parse(Buffer.from(receiptB64, "base64").toString());
      console.log("\nX-402-Receipt:", JSON.stringify(receipt, null, 2));
    }
    const body = await res.json();
    console.log("Response body:", body);
    console.log("\nFull cycle complete.");
  } else if (res.status === 402) {
    const refundB64 = res.headers.get("x-402-refund");
    const refund    = refundB64 ? JSON.parse(Buffer.from(refundB64, "base64").toString()) : null;
    console.error("Payment failed:", refund ?? await res.json());
  } else {
    console.error("Unexpected status:", res.status, await res.text());
  }
}

main().catch(console.error);
