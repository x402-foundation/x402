import { base58 } from "@scure/base";

/** The fields of the selected payment requirements that the expectation is compared with. */
export interface Offer {
  network: string;
  amount: string;
  payTo: string;
  asset: string;
}

/** What the caller agreed to pay for one resource. Fields left unset are not checked. */
export interface Expectation {
  /** The most the caller will pay, in the selected asset's atomic units. A lower price signs. */
  maxAmountAtomic?: string;
  /** CAIP-2 network id, e.g. "eip155:8453". Required when payTo or asset is pinned. */
  network?: string;
  payTo?: string;
  asset?: string;
}

/**
 * Reads the expectation from environment variables.
 *
 * @param env - The process environment
 * @returns The expectation; empty when nothing is pinned
 */
export function expectationFromEnv(env: Record<string, string | undefined>): Expectation {
  const expected: Expectation = {
    maxAmountAtomic: env.EXPECTED_AMOUNT_ATOMIC || undefined,
    network: env.EXPECTED_NETWORK || undefined,
    payTo: env.EXPECTED_PAY_TO || undefined,
    asset: env.EXPECTED_ASSET || undefined,
  };
  if (expected.maxAmountAtomic !== undefined && !/^\d+$/.test(expected.maxAmountAtomic)) {
    throw new Error("EXPECTED_AMOUNT_ATOMIC must be a whole number of atomic units");
  }
  if ((expected.payTo || expected.asset) && !expected.network) {
    // The same address text can name a different account, or a different token, on another
    // network, so a recipient or asset pin only means something together with its network.
    throw new Error("EXPECTED_PAY_TO and EXPECTED_ASSET need EXPECTED_NETWORK (e.g. eip155:8453)");
  }
  return expected;
}

/**
 * Decodes a Solana address to its 32 bytes.
 *
 * @param address - A Base58 address
 * @returns The 32 bytes, or null when the text is not a 32-byte Base58 value
 */
function solanaBytes(address: string): Uint8Array | null {
  try {
    const bytes = base58.decode(address);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Compares two addresses by the rules of the network they are on. EVM addresses are 20 bytes in
 * hex where letter case is only a checksum, so case is ignored. Solana addresses are Base58, where
 * case changes the value, so the decoded bytes are compared. Any other namespace never matches, so
 * a pinned recipient or asset fails closed there.
 *
 * @param network - CAIP-2 network id of the offer
 * @param a - First address
 * @param b - Second address
 * @returns True when both name the same account on that network
 */
export function sameAddress(network: string, a: string, b: string): boolean {
  if (network.startsWith("eip155:")) {
    const hex = /^0x[0-9a-fA-F]{40}$/;
    return hex.test(a) && hex.test(b) && a.toLowerCase() === b.toLowerCase();
  }
  if (network.startsWith("solana:")) {
    const x = solanaBytes(a);
    const y = solanaBytes(b);
    return x !== null && y !== null && x.every((byte, i) => byte === y[i]);
  }
  return false;
}

/**
 * Checks the selected requirements against the caller's expectation, before anything is signed.
 * The amount is a maximum: a price at or below it signs, a higher one is refused.
 *
 * @param offer - The selected payment requirements
 * @param expected - The caller's expectation
 * @returns The reason to refuse, or undefined when the offer is within the expectation
 */
export function refusalReason(offer: Offer, expected: Expectation): string | undefined {
  if (expected.network && offer.network !== expected.network) {
    return `network ${offer.network} is not the expected ${expected.network}`;
  }
  if (expected.maxAmountAtomic !== undefined) {
    if (!/^\d+$/.test(offer.amount)) {
      return `amount ${offer.amount} is not a whole number of atomic units`;
    }
    if (BigInt(offer.amount) > BigInt(expected.maxAmountAtomic)) {
      return `asked ${offer.amount} atomic units, expected at most ${expected.maxAmountAtomic}`;
    }
  }
  if (expected.payTo && !sameAddress(offer.network, offer.payTo, expected.payTo)) {
    return `payTo ${offer.payTo} is not the expected recipient`;
  }
  if (expected.asset && !sameAddress(offer.network, offer.asset, expected.asset)) {
    return `asset ${offer.asset} is not the expected asset`;
  }
  return undefined;
}
