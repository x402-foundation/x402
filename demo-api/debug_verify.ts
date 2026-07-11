import { createPublicClient, http, parseUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";

const RPC = "https://rpc.testnet.chain.robinhood.com";
const CHAIN_ID = 46630;
const PRIVATE_KEY = process.env.CLIENT_KEY || "";
const USDG = process.env.MOCK_USDG || "0xdDC7e17D6c06F8c5126b65fc9164481D87e6edE4";
const TO = "0x5131c099eB615227aB2Bb8b542D4cBd622910a25";

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

async function main() {
  const amount = parseUnits("0.5", 6);
  const nonce = keccak256(toHex(123456789));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = 0n;
  const validBefore = now + 3600n;

  const signature = await account.signTypedData({
    domain: {
      name: "USDG",
      version: "2",
      chainId: CHAIN_ID,
      verifyingContract: getAddress(USDG),
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: getAddress(TO),
      value: amount,
      validAfter,
      validBefore,
      nonce,
    },
  });

  const payload = {
    from: account.address,
    to: TO,
    value: toHex(amount),
    validAfter: toHex(validAfter),
    validBefore: toHex(validBefore),
    nonce,
    signature,
  };

  const requirements = {
    scheme: "exact",
    network: "eip155:46630",
    token: "USDG",
    amount: "0.5",
  };

  console.log("PAYLOAD:", JSON.stringify(payload, null, 2));

  const resp = await fetch("http://localhost:3001/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload, requirements }),
  });
  const result = await resp.json();
  console.log("VERIFY:", JSON.stringify(result, null, 2));
}

main().catch(console.error);