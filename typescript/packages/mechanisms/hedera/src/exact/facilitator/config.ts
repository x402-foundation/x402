import { HEDERA_MAX_CONTRACT_CALL_GAS, HEDERA_TRANSFER_EXECUTOR_WILDCARD } from "../../constants";
import { executorListAdmits } from "../../internal";
import type { FacilitatorHederaSigner } from "../../signer";
import { isSupportedHederaNetwork, isValidHederaEntityId } from "../../utils";

/**
 * Alias handling behavior for payTo checks.
 */
export type HederaAliasPolicy = "reject" | "allow";

/**
 * Facilitator options for the `transferExecutor` method.
 */
export type HederaTransferExecutorConfig = {
  /**
   * Admitted executor contract ids keyed by CAIP-2 network. An omitted network
   * or an empty list admits nothing; `"*"` admits any executor and must be
   * written out. Read on every request, so changes take effect immediately.
   */
  executors?: Partial<Record<string, string[]>>;
  /**
   * Gas limit used both to simulate and to submit `executeTransfer`. Fixed
   * when the scheme is constructed.
   */
  gasLimit: number;
  /**
   * Optional bound on the simulated gas estimate. When set, verification
   * rejects calls whose estimate exceeds it. Must not exceed `gasLimit`.
   * Fixed when the scheme is constructed.
   */
  simulationGasCeiling?: number;
};

/**
 * Facilitator options for exact Hedera verification.
 */
export type HederaFacilitatorConfig = {
  aliasPolicy?: HederaAliasPolicy;
  /**
   * Enables `transferExecutor` when the signer has every capability it needs.
   */
  transferExecutor?: HederaTransferExecutorConfig;
};

/**
 * Signer capabilities `transferExecutor` needs, all optional on the signer.
 */
export const TRANSFER_EXECUTOR_SIGNER_CAPABILITIES = [
  "resolveEvmAddress",
  "getTokenCustomFees",
  "simulateContractCall",
  "submitContractExecute",
  "getTransactionRecord",
] as const;

/**
 * A signer with every `transferExecutor` capability.
 */
export type TransferExecutorSigner = FacilitatorHederaSigner &
  Required<Pick<FacilitatorHederaSigner, (typeof TRANSFER_EXECUTOR_SIGNER_CAPABILITIES)[number]>>;

/**
 * Returns true when the value is a safe integer within `[min, max]`.
 *
 * @param value - Value to check
 * @param min - Inclusive lower bound
 * @param max - Inclusive upper bound
 * @returns True when within bounds
 */
function isSafeIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * Validates `transferExecutor` options and returns the copy the scheme keeps:
 * the gas settings are fixed, and the executor lists stay live, read from
 * `config.executors` on every request.
 *
 * @param config - Options to validate, or undefined when the method is not configured
 * @returns The scheme's copy, or undefined when the method is not configured
 * @throws Error when an option is invalid
 */
export function parseTransferExecutorConfig(
  config: HederaTransferExecutorConfig | undefined,
): HederaTransferExecutorConfig | undefined {
  if (config === undefined) {
    return undefined;
  }
  const { executors, gasLimit, simulationGasCeiling } = config;
  if (!isSafeIntegerInRange(gasLimit, 1, HEDERA_MAX_CONTRACT_CALL_GAS)) {
    throw new Error(
      `transferExecutor.gasLimit must be an integer between 1 and ${HEDERA_MAX_CONTRACT_CALL_GAS}`,
    );
  }
  if (
    simulationGasCeiling !== undefined &&
    !isSafeIntegerInRange(simulationGasCeiling, 1, gasLimit)
  ) {
    throw new Error(
      "transferExecutor.simulationGasCeiling must be an integer between 1 and transferExecutor.gasLimit",
    );
  }
  for (const [network, entries] of Object.entries(executors ?? {})) {
    if (!isSupportedHederaNetwork(network)) {
      throw new Error(`transferExecutor.executors: unsupported Hedera network ${network}`);
    }
    if (entries === undefined) {
      continue;
    }
    // Operators may pass untyped JSON, so the shapes are checked at runtime.
    if (!Array.isArray(entries)) {
      throw new Error(`transferExecutor.executors["${network}"] must be an array`);
    }
    for (const entry of entries) {
      if (
        entry !== HEDERA_TRANSFER_EXECUTOR_WILDCARD &&
        (typeof entry !== "string" || !isValidHederaEntityId(entry))
      ) {
        throw new Error(
          `transferExecutor.executors["${network}"] entry ${JSON.stringify(entry)} must be "*" or a Hedera contract id`,
        );
      }
    }
  }
  return {
    get executors() {
      return config.executors;
    },
    gasLimit,
    simulationGasCeiling,
  };
}

/**
 * Returns the executors admitted on a network, read from the live config.
 *
 * @param config - `transferExecutor` options
 * @param network - CAIP-2 network identifier
 * @returns Admitted executor entries, empty when none are configured
 */
export function getAdmittedExecutors(
  config: HederaTransferExecutorConfig | undefined,
  network: string,
): readonly string[] {
  return config?.executors?.[network] ?? [];
}

/**
 * Returns true when the options admit an executor on any network.
 *
 * @param config - `transferExecutor` options
 * @returns True when some network's executor list is not empty
 */
export function admitsAnyExecutor(config: HederaTransferExecutorConfig | undefined): boolean {
  return Object.values(config?.executors ?? {}).some(
    entries => entries !== undefined && entries.length > 0,
  );
}

/**
 * Returns true when an executor is admitted on a network, either by exact id
 * or through the `"*"` wildcard.
 *
 * @param config - `transferExecutor` options
 * @param network - CAIP-2 network identifier
 * @param executor - Executor contract id from the payload
 * @returns True when admitted
 */
export function isExecutorAdmitted(
  config: HederaTransferExecutorConfig | undefined,
  network: string,
  executor: string,
): boolean {
  return executorListAdmits(getAdmittedExecutors(config, network), executor);
}

/**
 * Returns true when `transferExecutor` can run on a network: it admits at
 * least one executor there, and the signer has every capability and a fee
 * payer account.
 *
 * @param signer - Facilitator signer
 * @param config - `transferExecutor` options
 * @param network - CAIP-2 network identifier
 * @returns True when the method is enabled on `network`
 */
export function isTransferExecutorEnabled(
  signer: FacilitatorHederaSigner,
  config: HederaTransferExecutorConfig | undefined,
  network: string,
): signer is TransferExecutorSigner {
  return (
    isSupportedHederaNetwork(network) &&
    getAdmittedExecutors(config, network).length > 0 &&
    TRANSFER_EXECUTOR_SIGNER_CAPABILITIES.every(
      capability => typeof signer[capability] === "function",
    ) &&
    signer.getAddresses().length > 0
  );
}
