/**
 * Zcash (shielded) mechanism for x402.
 *
 * This is a stub that defines the Zcash network configuration
 * for the x402 protocol. The full payment construction and
 * verification logic is in @frontiercompute/zcash-402.
 *
 * Zcash uses encrypted memos for payment ID matching,
 * unlike EVM/SVM which use on-chain event logs.
 */

export const ZCASH_NETWORK = {
  name: "zcash",
  caip2: "zcash:mainnet",
  rpcDefault: "http://127.0.0.1:8232",
  asset: {
    symbol: "ZEC",
    decimals: 8,
    native: true,
  },
  settlement: "shielded-memo",
  facilitatorPackage: "@frontiercompute/zcash-402",
} as const;

export type ZcashPaymentProof = {
  txid: string;
  memo: string;
  amount_zat: number;
  attestation_leaf?: string;
};

export function isZcashNetwork(caip2: string): boolean {
  return caip2.startsWith("zcash:");
}
