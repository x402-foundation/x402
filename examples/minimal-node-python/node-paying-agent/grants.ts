/**
 * x402 Agent Grant — canonical sign / verify / shouldCheckRevocation
 * Copied from specs/grants.md (v1.0) — do not modify independently.
 *
 * Verified against all 6 test vectors in specs/test-vectors.json.
 */
import { ethers } from "ethers";

export const DOMAIN = {
  name:              "x402-AgentGrant",
  version:           "1",
  chainId:           8453,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

export const TYPES = {
  x402Grant: [
    { name: "grantId",       type: "uint256"   },
    { name: "principal",     type: "address"   },
    { name: "agent",         type: "address"   },
    { name: "issuedAt",      type: "uint256"   },
    { name: "expiration",    type: "uint256"   },
    { name: "totalBudget",   type: "uint256"   },
    { name: "perRequestCap", type: "uint256"   },
    { name: "scopes",        type: "bytes32[]" },
    { name: "salt",          type: "bytes32"   },
  ],
} as const;

export interface x402Grant {
  grantId:       bigint;
  principal:     string;
  agent:         string;
  issuedAt:      bigint;
  expiration:    bigint;
  totalBudget:   bigint;
  perRequestCap: bigint;
  scopes:        string[];
  salt:          string;
}

/** Sign a grant with an ethers v6 Signer. Returns the EIP-712 signature. */
export async function signGrant(
  signer: ethers.Signer,
  grant:  x402Grant
): Promise<string> {
  return signer.signTypedData(DOMAIN, TYPES, grant);
}

/**
 * Verify a grant signature and check expiry + agent address.
 *
 * Rules (from specs/grants.md §7):
 * 1. grant.expiration must be > now + 30 (±30s clock skew grace)
 * 2. grant.issuedAt must be ≤ now + 30
 * 3. grant.agent must match currentAgent
 * 4. EIP-712 signature must recover to grant.principal
 */
export function verifyGrant(
  grant:        any,
  signature:    string,
  currentAgent: string,
  now           = Math.floor(Date.now() / 1000)
): boolean {
  // 1. Expiry check (grant must expire more than 30s from now)
  if (Number(grant.expiration) <= now + 30) return false;
  // 2. issuedAt check
  if (Number(grant.issuedAt) > now + 30) return false;
  // 3. Agent address check
  if (grant.agent.toLowerCase() !== currentAgent.toLowerCase()) return false;

  // 4. EIP-712 signature recovery — normalize string fields to BigInt
  const normalized = {
    ...grant,
    grantId:       BigInt(grant.grantId),
    issuedAt:      BigInt(grant.issuedAt),
    expiration:    BigInt(grant.expiration),
    totalBudget:   BigInt(grant.totalBudget),
    perRequestCap: BigInt(grant.perRequestCap),
  };

  try {
    const digest    = ethers.TypedDataEncoder.hash(DOMAIN, TYPES, normalized);
    const recovered = ethers.recoverAddress(digest, signature);
    return recovered.toLowerCase() === grant.principal.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Returns true if the grant is in its final 30% of lifetime.
 * When true, the receiver SHOULD query the revocation registry.
 */
export function shouldCheckRevocation(
  grant: any,
  now   = Math.floor(Date.now() / 1000)
): boolean {
  const lifetime  = Number(grant.expiration) - Number(grant.issuedAt);
  const remaining = Number(grant.expiration) - now;
  return remaining < lifetime * 0.3;
}
