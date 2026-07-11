/**
 * Payment verification & settlement for Robinhood Chain x402 (v2 wire format).
 *
 * Accepts the x402 v2 PaymentPayload shape:
 *   { x402Version, scheme, network, payload: { signature, authorization: { from,to,value,validAfter,validBefore,nonce } } }
 * with atomic DECIMAL string values (per spec). Also tolerates legacy hex + flat payloads.
 *
 * Two modes:
 *   - EIP-3009 (gasless transferWithAuthorization) — USDG native
 *   - Permit2 (permitWitnessTransferFrom) — fallback for any ERC-20
 */
import {
  type Address,
  type PublicClient,
  type WalletClient,
  hexToBigInt,
  getAddress,
  slice,
  recoverTypedDataAddress,
} from "viem";

// ── Constants ───────────────────────────────────────────
const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const USDG: Address = (process.env.MOCK_USDG_ADDRESS || "0xdDC7e17D6c06F8c5126b65fc9164481D87e6edE4") as Address;
const USDG_DECIMALS = 6;
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "46630");

// ── Helpers ─────────────────────────────────────────────
// Accept decimal string (v2 spec) OR 0x-hex (legacy). Returns bigint.
function toBig(x: string | number | bigint): bigint {
  if (typeof x === "bigint") return x;
  if (typeof x === "number") return BigInt(x);
  const s = String(x).trim();
  if (s.startsWith("0x") || s.startsWith("0X")) return hexToBigInt(s as `0x${string}`);
  return BigInt(s);
}

// Resolve the token address from a v2 `asset` (address) or legacy `token` ("USDG").
function resolveToken(requirements: any): Address {
  const a = requirements?.asset || requirements?.token;
  if (!a || a === "USDG") return USDG;
  return getAddress(a);
}

// Normalize a v2 PaymentPayload (or legacy flat payload) to a flat EIP-3009 auth object.
function normalizeAuth(paymentPayload: any): {
  from: Address; to: Address; value: bigint;
  validAfter: bigint; validBefore: bigint; nonce: `0x${string}`; signature: `0x${string}`;
} | null {
  // v2: paymentPayload.payload.{signature, authorization}
  const inner = paymentPayload?.payload ?? paymentPayload;
  const auth = inner?.authorization ?? inner;
  const signature = (inner?.signature ?? paymentPayload?.signature) as `0x${string}` | undefined;
  if (!auth?.from || !auth?.nonce || !signature) return null;
  return {
    from: getAddress(auth.from),
    to: getAddress(auth.to),
    value: toBig(auth.value),
    validAfter: toBig(auth.validAfter),
    validBefore: toBig(auth.validBefore),
    nonce: auth.nonce as `0x${string}`,
    signature,
  };
}

// EIP-3009 authorization state lookup
const eip3009Abi = [
  { inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }], name: "authorizationState", outputs: [{ name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }], name: "allowance", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

// EIP-3009 transferWithAuthorization ABI
const transferWithAuthorizationAbi = [
  { inputs: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" },
  ], name: "transferWithAuthorization", outputs: [], stateMutability: "nonpayable", type: "function" },
] as const;

// EIP-3009 domain types
const eip3009DomainTypes = {
  EIP712Domain: [
    { name: "name", type: "string" }, { name: "version", type: "string" },
    { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
  ],
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};

// ── Verify: EIP-3009 (v2) ───────────────────────────────
async function verifyEIP3009(
  client: PublicClient,
  paymentPayload: any,
  requirements: any,
): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }> {
  const a = normalizeAuth(paymentPayload);
  if (!a) return { isValid: false, invalidReason: "malformed_payload" };

  const token = resolveToken(requirements);

  // 1. Nonce not used
  const used = await client.readContract({ address: token, abi: eip3009Abi, functionName: "authorizationState", args: [a.from, a.nonce] });
  if (used) return { isValid: false, invalidReason: "nonce_already_used", payer: a.from };

  // 2. Balance sufficient
  const balance = await client.readContract({ address: token, abi: eip3009Abi, functionName: "balanceOf", args: [a.from] }) as bigint;
  if (balance < a.value) return { isValid: false, invalidReason: "insufficient_funds", payer: a.from };

  // 3. Amount matches requirements (atomic units) — spec step 3
  if (requirements?.amount != null) {
    const required = toBig(requirements.amount);
    if (a.value !== required) return { isValid: false, invalidReason: "amount_mismatch", payer: a.from };
  }

  // 3b. Recipient matches requirements.payTo — prevents signed authorization being
  // redirected to an attacker-controlled address (payTo is server-specified, not
  // client-chosen, so it must be pinned and checked server-side before settling).
  if (requirements?.payTo) {
    const expectedPayTo = getAddress(requirements.payTo);
    if (a.to.toLowerCase() !== expectedPayTo.toLowerCase()) {
      return { isValid: false, invalidReason: "recipient_mismatch", payer: a.from };
    }
  }

  // 4. Time window
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (a.validAfter > now) return { isValid: false, invalidReason: "authorization_not_yet_valid", payer: a.from };
  if (a.validBefore < now) return { isValid: false, invalidReason: "authorization_expired", payer: a.from };

  // 5. Signature recovery — derive EIP-712 domain from requirements.extra per SDK spec
  const extra = requirements?.extra || {};
  const domainName = typeof extra.name === "string" ? extra.name : "USDG";
  const domainVersion = typeof extra.version === "string" ? extra.version : "2";
  const netStr = typeof requirements?.network === "string" ? requirements.network : "";
  const chainIdFromNet = netStr.startsWith("eip155:") ? parseInt(netStr.split(":")[1], 10) : NaN;
  const chainIdEff = Number.isFinite(chainIdFromNet) && chainIdFromNet > 0 ? chainIdFromNet : CHAIN_ID;
  const domain = { name: domainName, version: domainVersion, chainId: BigInt(chainIdEff), verifyingContract: token };
  const message = { from: a.from, to: a.to, value: a.value, validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce };
  const sig = a.signature;
  const v = parseInt(slice(sig, 64, 65), 16);
  const r = slice(sig, 0, 32);
  const s = slice(sig, 32, 64);
  try {
    const recovered = await recoverTypedDataAddress({ domain, types: eip3009DomainTypes, primaryType: "TransferWithAuthorization", message, signature: { v, r, s } });
    if (recovered.toLowerCase() !== a.from.toLowerCase()) return { isValid: false, invalidReason: "signature_mismatch", payer: a.from };
  } catch {
    return { isValid: false, invalidReason: "signature_verification_failed", payer: a.from };
  }

  return { isValid: true, payer: a.from };
}

// ── Settle: EIP-3009 (v2) ───────────────────────────────
async function settleEIP3009(
  wallet: WalletClient,
  paymentPayload: any,
  requirements: any,
): Promise<{ success: boolean; transaction: string; network: string; payer?: string; errorReason?: string }> {
  const network = requirements?.network || `eip155:${CHAIN_ID}`;
  const a = normalizeAuth(paymentPayload);
  if (!a) return { success: false, transaction: "", network, errorReason: "malformed_payload" };

  const token = resolveToken(requirements);
  const sig = a.signature;
  const v = parseInt(slice(sig, 64, 65), 16);
  const r = slice(sig, 0, 32);
  const s = slice(sig, 32, 64);

  try {
    const hash = await wallet.writeContract({
      address: token,
      abi: transferWithAuthorizationAbi,
      functionName: "transferWithAuthorization",
      args: [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s],
      chain: wallet.chain,
      account: wallet.account!,
    });
    return { success: true, transaction: hash, network, payer: a.from };
  } catch (err: any) {
    return { success: false, transaction: "", network, payer: a.from, errorReason: err.shortMessage || err.message };
  }
}

// ── Public API ──────────────────────────────────────────
export async function verifyPayment(client: PublicClient, paymentPayload: any, requirements: any): Promise<any> {
  const scheme = paymentPayload?.scheme || requirements?.scheme || "exact";
  if (scheme === "exact") return verifyEIP3009(client, paymentPayload, requirements);
  return { isValid: false, invalidReason: "unsupported_scheme" };
}

export async function settlePayment(wallet: WalletClient, _client: PublicClient, paymentPayload: any, requirements: any): Promise<any> {
  const scheme = paymentPayload?.scheme || requirements?.scheme || "exact";
  if (scheme === "exact") return settleEIP3009(wallet, paymentPayload, requirements);
  return { success: false, transaction: "", network: requirements?.network || `eip155:${CHAIN_ID}`, errorReason: "unsupported_scheme" };
}
