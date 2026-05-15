import { ethers } from "ethers";
import fetch from "node-fetch";

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RECEIVER_URL = "http://localhost:3000/api/tool";

const DOMAIN = {
  name: "x402-AgentGrant",
  version: "1",
  chainId: 8453,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

const TYPES = {
  x402Grant: [
    { name: "grantId", type: "uint256" },
    { name: "principal", type: "address" },
    { name: "agent", type: "address" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "totalBudget", type: "uint256" },
    { name: "perRequestCap", type: "uint256" },
    { name: "scopes", type: "bytes32[]" },
    { name: "salt", type: "bytes32" },
  ],
};

async function main() {
  const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);

  console.log("📝 Creating x402 grant...");

  const grant = {
    grantId: BigInt(1),
    principal: wallet.address,
    agent: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    issuedAt: BigInt(Math.floor(Date.now() / 1000)),
    expiration: BigInt(Math.floor(Date.now() / 1000) + 900),
    totalBudget: BigInt(1000000000),
    perRequestCap: BigInt(5000000),
    scopes: ["0x8f3a8c9b2d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a"],
    salt: ethers.id("test-salt-" + Date.now()),
  };

  console.log("🔐 Signing with EIP-712...");
  const signature = await wallet.signTypedData(DOMAIN, TYPES, grant);

  const requestBody = { tool: "example-tool", params: {} };
  const receiptHash = ethers.id(JSON.stringify(requestBody));

  const paymentHeader = {
    grant,
    signature,
    receiptHash,
  };

  console.log("🔥 Sending x402 request to", RECEIVER_URL);

  const res = await fetch(RECEIVER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-402-Payment": Buffer.from(JSON.stringify(paymentHeader)).toString("base64"),
    },
    body: JSON.stringify(requestBody),
  });

  const receiptHeader = res.headers.get("x-402-receipt");
  if (receiptHeader) {
    const receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString());
    console.log("✅ Received", res.status, "— Receipt:");
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    console.log("✅ Received", res.status, "but no receipt header");
  }
}

main().catch(console.error);
