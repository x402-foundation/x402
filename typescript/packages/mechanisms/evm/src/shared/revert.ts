/**
 * Distinguishes an on-chain contract revert from a transport/RPC failure.
 *
 * Used by the post-deploy ERC-6492 simulation paths: after a successful factory deploy, a
 * simulation that reverts means the deployed wallet's validator rejected the inner signature
 * (deterministic, retry-with-standard-sig guidance applies). A transport/RPC failure is NOT a
 * signature problem and must not be reported as one.
 *
 * Matches the revert-substring heuristic already used by `parseEip3009TransferError`.
 *
 * @param error - The error thrown by an `eth_call` / simulation.
 * @returns `true` if the error looks like a contract revert, `false` for transport/RPC failures.
 */
export function isContractRevert(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /revert/i.test(message);
}
