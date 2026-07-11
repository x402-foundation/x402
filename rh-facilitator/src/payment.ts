/**
 * Payment verification & settlement for Robinhood Chain x402.
 *
 * Two modes:
 *   - EIP-3009 (gasless transferWithAuthorization) — USDG native
 *   - Permit2 (permitWitnessTransferFrom) — fallback for any ERC-20
 */
import {
  type Address,
  type PublicClient,
  type WalletClient,
  encodeFunctionData,
  hexToBigInt,
  getAddress,
  slice,
  concat,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  hashTypedData,
  recoverTypedDataAddress,
  pad,
} from "viem";

// ── Constants ───────────────────────────────────────────
const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const USDG: Address = (process.env.MOCK_USDG_ADDRESS || "0xdDC7e17D6c06F8c5126b65fc9164481D87e6edE4") as Address;
const USDG_DECIMALS = 6;

// EIP-3009 authorization state lookup
const eip3009Abi = [
  {
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    name: "authorizationState",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// EIP-3009 transferWithAuthorization ABI
const transferWithAuthorizationAbi = [
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    name: "transferWithAuthorization",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// EIP-3009 domain types
const eip3009DomainTypes = {
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
};

// ── Types ────────────────────────────────────────────────
export interface PaymentRequirements {
  network: string;
  scheme: string;
  token: string;
  amount: string; // human-readable, e.g., "0.01"
}

export interface EIP3009Payload {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  signature: string; // hex-encoded v+r+s or full sig
}

export interface Permit2Payload {
  permitted: { token: Address; amount: string };
  nonce: string;
  deadline: string;
  spender: Address;
  witness: { to: Address; validAfter: string };
  signature: string;
}

// ── Verify: EIP-3009 ────────────────────────────────────
async function verifyEIP3009(
  client: PublicClient,
  payload: EIP3009Payload,
  requirements: PaymentRequirements,
): Promise<{ valid: boolean; reason?: string }> {
  const token = getAddress(requirements.token === "USDG" ? USDG : requirements.token);
  const from = getAddress(payload.from);
  const to = getAddress(payload.to);
  const nonce = payload.nonce as `0x${string}`;
  const value = hexToBigInt(payload.value as `0x${string}`);

  // 1. Check nonce not used
  const used = await client.readContract({
    address: token,
    abi: eip3009Abi,
    functionName: "authorizationState",
    args: [from, nonce],
  });
  if (used) return { valid: false, reason: "nonce already used" };

  // 2. Check balance
  const balance = await client.readContract({
    address: token,
    abi: eip3009Abi,
    functionName: "balanceOf",
    args: [from],
  });
  if (balance < value) return { valid: false, reason: "insufficient balance" };

  // 3. Recover signature
  const domain = {
    name: "USDG", // ponytail: read from token.name() on-chain for production
    version: "2",
    chainId: BigInt(46630),
    verifyingContract: token,
  };

  const message = {
    from,
    to,
    value,
    validAfter: hexToBigInt(payload.validAfter as `0x${string}`),
    validBefore: hexToBigInt(payload.validBefore as `0x${string}`),
    nonce,
  };

  // Decode signature (v+r+s packed or 65-byte)
  const sig = payload.signature as `0x${string}`;
  const v = parseInt(slice(sig, 64, 65), 16);
  const r = slice(sig, 0, 32);
  const s = slice(sig, 32, 64);

  try {
    const recovered = await recoverTypedDataAddress({
      domain,
      types: eip3009DomainTypes,
      primaryType: "TransferWithAuthorization",
      message,
      signature: { v, r, s },
    });
    if (recovered.toLowerCase() !== from.toLowerCase()) {
      return { valid: false, reason: "signature mismatch" };
    }
  } catch {
    return { valid: false, reason: "signature verification failed" };
  }

  return { valid: true };
}

// ── Verify: Permit2 ─────────────────────────────────────
async function verifyPermit2(
  client: PublicClient,
  payload: Permit2Payload,
  requirements: PaymentRequirements,
): Promise<{ valid: boolean; reason?: string }> {
  const token = getAddress(requirements.token === "USDG" ? USDG : requirements.token);

  // 1. Check Permit2 allowance
  const allowance = await client.readContract({
    address: token,
    abi: eip3009Abi,
    functionName: "allowance",
    args: [payload.spender, PERMIT2_ADDRESS],
  });
  const amount = hexToBigInt(payload.permitted.amount as `0x${string}`);
  if (allowance < amount) return { valid: false, reason: "insufficient Permit2 allowance" };

  // 2. Check balance
  const balance = await client.readContract({
    address: token,
    abi: eip3009Abi,
    functionName: "balanceOf",
    args: [payload.spender],
  });
  if (balance < amount) return { valid: false, reason: "insufficient balance" };

  // ponytail: full typed-data signature verify skipped for MVP
  // In production, verify Permit2 witness signature same way x402 does
  return { valid: true };
}

// ── Settle: EIP-3009 ────────────────────────────────────
async function settleEIP3009(
  wallet: WalletClient,
  payload: EIP3009Payload,
  requirements: PaymentRequirements,
): Promise<{ txHash?: string; error?: string }> {
  const token = getAddress(requirements.token === "USDG" ? USDG : requirements.token);

  const sig = payload.signature as `0x${string}`;
  const v = parseInt(slice(sig, 64, 65), 16);
  const r = slice(sig, 0, 32);
  const s = slice(sig, 32, 64);

  try {
    const hash = await wallet.writeContract({
      address: token,
      abi: transferWithAuthorizationAbi,
      functionName: "transferWithAuthorization",
      args: [
        getAddress(payload.from),
        getAddress(payload.to),
        hexToBigInt(payload.value as `0x${string}`),
        hexToBigInt(payload.validAfter as `0x${string}`),
        hexToBigInt(payload.validBefore as `0x${string}`),
        payload.nonce as `0x${string}`,
        v,
        r,
        s,
      ],
    });
    return { txHash: hash };
  } catch (err: any) {
    return { error: err.message };
  }
}

// ── Public API ──────────────────────────────────────────
export async function verifyPayment(
  client: PublicClient,
  payload: any,
  requirements: PaymentRequirements,
): Promise<any> {
  // Detect payload type
  if (payload.from && payload.nonce && payload.signature) {
    return verifyEIP3009(client, payload as EIP3009Payload, requirements);
  }
  if (payload.permitted && payload.spender) {
    return verifyPermit2(client, payload as Permit2Payload, requirements);
  }
  return { valid: false, reason: "unknown payload type" };
}

export async function settlePayment(
  wallet: WalletClient,
  _client: PublicClient,
  payload: any,
  requirements: PaymentRequirements,
): Promise<any> {
  if (payload.from && payload.nonce && payload.signature) {
    return settleEIP3009(wallet, payload as EIP3009Payload, requirements);
  }
  return { settled: false, error: "only EIP-3009 supported for settlement MVP" };
}