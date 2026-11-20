import type { HederaTransferExecutorConfig } from "@x402/hedera/exact/facilitator";

type EnvLookup = (key: string) => string | undefined;

/** Gas for simulating and submitting `executeTransfer`, as in the package's live test. */
const DEFAULT_GAS_LIMIT = 400_000;

/**
 * `transferExecutor` options for the e2e facilitator, read from env.
 *
 * @param network - CAIP-2 network the facilitator registers Hedera on
 * @param env - Env lookup
 * @returns The options, or undefined when `HEDERA_TE_EXECUTOR_ID` is unset
 */
export function hederaTransferExecutorOptions(
  network: string,
  env: EnvLookup = key => process.env[key],
): HederaTransferExecutorConfig | undefined {
  const executor = env("HEDERA_TE_EXECUTOR_ID")?.trim();
  if (!executor) {
    return undefined;
  }
  return { executors: { [network]: [executor] }, gasLimit: gasLimit(env) };
}

/**
 * Reads `HEDERA_TE_GAS_LIMIT`. The scheme constructor checks its range.
 *
 * @param env - Env lookup
 * @returns The gas limit, or the default when unset
 */
function gasLimit(env: EnvLookup): number {
  const raw = env("HEDERA_TE_GAS_LIMIT")?.trim();
  if (!raw) {
    return DEFAULT_GAS_LIMIT;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`HEDERA_TE_GAS_LIMIT must be a whole number, got "${raw}"`);
  }
  return Number(raw);
}
