/**
 * Demo client — requests weather API, handles 402 payment flow.
 * Signs EIP-3009 authorization for USDG transfer + retries with Payment-Signature.
 */
import { createPublicClient, http, parseUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";

const RPC = "https://rpc.testnet.chain.robinhood.com";
const CHAIN_ID = 46630;
const WEATHER_API = process.env.API_URL || "http://localhost:3005";
const PRIVATE_KEY = process.env.CLIENT_KEY || "";
const USDG = process.env.MOCK_USDG || "0xdDC7e17D6c06F8c5126b65fc9164481D87e6edE4";

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ transport: http(RPC) });

const TransferWithAuthorizationType = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

async function main() {
  // Step 1: POST /weather without payment -> expect 402
  console.log("1. POST /weather (no payment)...");
  const r1 = await fetch(`${WEATHER_API}/weather`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (r1.status !== 402) {
    console.log(`Unexpected status: ${r1.status}`, await r1.text());
    return;
  }
  const paymentHeader = r1.headers.get("payment-required");
  if (!paymentHeader) throw new Error("No Payment-Required header");
  const reqs = JSON.parse(paymentHeader);
  console.log(`   402 - need ${reqs.amount} ${reqs.token}`);

  // Step 2: Sign EIP-3009
  const amount = parseUnits(reqs.amount, 6);
  const nonce = keccak256(toHex(Math.floor(Math.random() * 1e16)));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = 0n;
  const validBefore = now + 3600n;
  const to = getAddress("0x5131c099eB615227aB2Bb8b542D4cBd622910a25");

  console.log("2. Signing EIP-3009...");
  const signature = await account.signTypedData({
    domain: {
      name: "USDG",
      version: "2",
      chainId: BigInt(CHAIN_ID),
      verifyingContract: getAddress(USDG),
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: TransferWithAuthorizationType,
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to,
      value: amount,
      validAfter,
      validBefore,
      nonce,
    },
  });

  const payload = JSON.stringify({
    from: account.address,
    to,
    value: toHex(amount),
    validAfter: toHex(validAfter),
    validBefore: toHex(validBefore),
    nonce,
    signature,
  });

  // Step 3: POST /weather with payment -> verify + settle on-chain
  console.log("3. POST with payment signature -> verify + settle on-chain...");
  const r2 = await fetch(`${WEATHER_API}/weather`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "payment-signature": signature,
      "payment-payload": payload,
      "payment-network": reqs.network,
    },
  });

  const result = await r2.json();
  if (r2.ok) {
    console.log("WEATHER DATA:", JSON.stringify(result, null, 2));
  } else {
    console.log(`FAIL ${r2.status}:`, JSON.stringify(result, null, 2));
  }
}

main().catch(console.error);