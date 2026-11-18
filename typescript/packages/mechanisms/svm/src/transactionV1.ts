import {
  getBase64Encoder,
  setTransactionMessageConfig,
  TRANSACTION_CONFIG_COMPUTE_UNIT_LIMIT_BIT_MASK,
  TRANSACTION_CONFIG_HEAP_SIZE_BIT_MASK,
  TRANSACTION_CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT_MASK,
  TRANSACTION_CONFIG_PRIORITY_FEE_LAMPORTS_BIT_MASK,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "./constants";

/** Serialized size limit of a legacy or version-0 transaction. */
export const V0_MAX_TRANSACTION_SIZE = 1_232;

/** Serialized size limit of a version-1 transaction (SIMD-0385). */
export const V1_MAX_TRANSACTION_SIZE = 4_096;

/**
 * Loaded-account-data budget a client sets on the version-1 transactions it
 * builds. Four MiB covers the mainnet Token-2022 program-data account (about
 * 1.4 MiB) plus the remaining programs and accounts a payment loads. The
 * budget only bounds what the transaction may load; it is not charged as a fee.
 */
export const DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 4_194_304;

/** Transaction message version a client builds. */
export type BuildableTransactionVersion = 0 | 1;

/**
 * The serialized size limit for a transaction message version.
 *
 * @param version - The message version
 * @returns The maximum serialized transaction size in bytes
 */
export function maxTransactionSize(version: number | string): number {
  return version === 1 ? V1_MAX_TRANSACTION_SIZE : V0_MAX_TRANSACTION_SIZE;
}

/**
 * Whether a base64 wire transaction exceeds the serialized size limit of its
 * message version (legacy is policed as version 0). Verifiers call this after
 * the version gate: the decoder accepts an oversized transaction, but the
 * network would drop it after the sponsor co-signed it.
 *
 * @param transactionBase64 - The base64 wire transaction
 * @param version - Its message version
 * @returns The size and limit when the transaction is too large, otherwise undefined
 */
export function transactionSizeExceeded(
  transactionBase64: string,
  version: number | string,
): { size: number; limit: number } | undefined {
  const size = getBase64Encoder().encode(transactionBase64).byteLength;
  const limit = maxTransactionSize(version);
  return size > limit ? { size, limit } : undefined;
}

/**
 * Convert a compute unit price to a version-1 total priority fee, rounding up
 * so the fee never undercuts the price the v0 instruction would have paid.
 *
 * @param computeUnitLimit - Requested compute units
 * @param microLamports - Price in microlamports per compute unit
 * @returns Total priority fee in lamports
 */
export function priorityFeeLamports(computeUnitLimit: number, microLamports: number): bigint {
  if (microLamports <= 0) return 0n;
  return (BigInt(computeUnitLimit) * BigInt(Math.trunc(microLamports)) + 999_999n) / 1_000_000n;
}

/** Compute budget a client requests for a transaction it builds. */
export interface ClientComputeBudget {
  /** Compute unit limit; `0` omits it on version 0 and is rejected on version 1. */
  computeUnitLimit: number;
  /** Price in microlamports per compute unit; `0` omits it. */
  computeUnitPriceMicroLamports: number;
  /** Version-1 loaded-account-data budget. Defaults to {@link DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT}. */
  loadedAccountsDataSizeLimit?: number | undefined;
}

/**
 * The Compute Budget instructions a version-0 transaction carries. Version 1
 * carries its budget in the message config instead, so it gets none.
 *
 * @param version - The message version being built
 * @param budget - The requested compute budget
 * @returns The `SetComputeUnitLimit` / `SetComputeUnitPrice` prefix
 */
export function computeBudgetInstructions(
  version: BuildableTransactionVersion,
  budget: ClientComputeBudget,
) {
  if (version === 1) return [];
  return [
    ...(budget.computeUnitLimit > 0
      ? [getSetComputeUnitLimitInstruction({ units: budget.computeUnitLimit })]
      : []),
    ...(budget.computeUnitPriceMicroLamports > 0
      ? [getSetComputeUnitPriceInstruction({ microLamports: budget.computeUnitPriceMicroLamports })]
      : []),
  ];
}

/**
 * Set the version-1 message config for a client-built transaction. Both the
 * compute unit limit and the loaded-account-data budget are set, since an
 * unset value requests zero and the transaction could not execute. Version-0
 * messages are returned unchanged.
 *
 * @param version - The message version being built
 * @param budget - The requested compute budget
 * @param message - The transaction message
 * @returns The message, with its config set on version 1
 */
export function applyTransactionV1Config<TMessage>(
  version: BuildableTransactionVersion,
  budget: ClientComputeBudget,
  message: TMessage,
): TMessage {
  if (version !== 1) return message;
  if (!Number.isSafeInteger(budget.computeUnitLimit) || budget.computeUnitLimit <= 0) {
    throw new Error("a version-1 transaction must set a positive computeUnitLimit");
  }
  const fee = priorityFeeLamports(budget.computeUnitLimit, budget.computeUnitPriceMicroLamports);
  return setTransactionMessageConfig(
    {
      computeUnitLimit: budget.computeUnitLimit,
      loadedAccountsDataSizeLimit:
        budget.loadedAccountsDataSizeLimit ?? DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
      ...(fee > 0n ? { priorityFeeLamports: fee } : {}),
    },
    message as never,
  ) as TMessage;
}

/** A compiled message instruction in a version-neutral shape. */
export interface CompiledInstructionView {
  programAddressIndex: number;
  accountIndices: readonly number[];
  data: Uint8Array | undefined;
}

type CompiledMessageLike = {
  version: number | string;
  instructions?: readonly {
    programAddressIndex: number;
    accountIndices?: readonly number[];
    data?: Uint8Array | undefined;
  }[];
  instructionHeaders?: readonly { programAccountIndex: number }[];
  instructionPayloads?: readonly {
    instructionAccountIndices: readonly number[];
    instructionData: Uint8Array;
  }[];
};

/**
 * List a compiled message's instructions in one shape across versions. A
 * compiled version-1 message splits each instruction into a header and a
 * payload instead of carrying an `instructions` array.
 *
 * @param compiled - A compiled transaction message
 * @returns Its instructions as program index, account indices, and data
 */
export function getCompiledInstructions(compiled: unknown): CompiledInstructionView[] {
  const message = compiled as CompiledMessageLike;
  if (message.version === 1) {
    const headers = message.instructionHeaders ?? [];
    const payloads = message.instructionPayloads ?? [];
    if (headers.length !== payloads.length) {
      throw new Error("transaction v1 instruction headers and payloads differ in length");
    }
    return headers.map((header, i) => ({
      programAddressIndex: header.programAccountIndex,
      accountIndices: payloads[i]!.instructionAccountIndices,
      data: payloads[i]!.instructionData,
    }));
  }
  return (message.instructions ?? []).map(ix => ({
    programAddressIndex: ix.programAddressIndex,
    accountIndices: ix.accountIndices ?? [],
    data: ix.data,
  }));
}

/** The config values of a version-1 message, read from its mask. */
export interface TransactionV1Config {
  /** Raw `TransactionConfigMask`. */
  mask: number;
  priorityFeeLamports?: bigint | undefined;
  computeUnitLimit?: number | undefined;
  loadedAccountsDataSizeLimit?: number | undefined;
  heapSize?: number | undefined;
}

type CompiledV1ConfigLike = {
  configMask?: number;
  configValues?: readonly { kind: string; value: bigint | number }[];
};

/**
 * Read the config of a compiled version-1 message from its mask and values.
 * Values follow the mask's bit order: priority fee (u64), compute unit limit,
 * loaded-account-data limit, heap size (u32 each).
 *
 * @param compiled - A compiled version-1 transaction message
 * @returns The mask and the values it sets
 */
export function readTransactionV1Config(compiled: unknown): TransactionV1Config {
  const message = compiled as CompiledV1ConfigLike;
  const mask = message.configMask ?? 0;
  const values = [...(message.configValues ?? [])];
  const config: TransactionV1Config = { mask };
  const priorityBits = mask & TRANSACTION_CONFIG_PRIORITY_FEE_LAMPORTS_BIT_MASK;
  if (priorityBits !== 0) {
    config.priorityFeeLamports = BigInt(values.shift()?.value ?? 0);
  }
  if (mask & TRANSACTION_CONFIG_COMPUTE_UNIT_LIMIT_BIT_MASK) {
    config.computeUnitLimit = Number(values.shift()?.value ?? 0);
  }
  if (mask & TRANSACTION_CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT_MASK) {
    config.loadedAccountsDataSizeLimit = Number(values.shift()?.value ?? 0);
  }
  if (mask & TRANSACTION_CONFIG_HEAP_SIZE_BIT_MASK) {
    config.heapSize = Number(values.shift()?.value ?? 0);
  }
  return config;
}

/** Why a version-1 transaction's compute budget fails sponsor policy. */
export type TransactionV1BudgetViolation =
  | "priority_fee_bits"
  | "heap_size"
  | "compute_budget_instruction"
  | "compute_unit_limit_missing"
  | "compute_unit_limit_too_high"
  | "loaded_accounts_data_size_limit_missing"
  | "priority_fee_too_high";

/** Caps a sponsor applies to a version-1 transaction's config. */
export interface TransactionV1BudgetLimits {
  /** Maximum compute unit limit; unbounded when omitted. */
  maxComputeUnits?: number | undefined;
  /** Compute unit price cap of the accepting path, in microlamports per CU. */
  maxPriceMicroLamports: number | bigint;
}

/**
 * Check a client-built version-1 transaction's compute budget against sponsor
 * policy: both priority-fee bits or neither, no heap request, a compute unit
 * limit within the cap, a loaded-account-data budget, no Compute Budget
 * instructions, and `priorityFee * 1e6 <= cap * computeUnitLimit` evaluated in
 * arbitrary precision so an oversized fee cannot wrap.
 *
 * @param config - The message config, from {@link readTransactionV1Config}
 * @param programAddresses - The program address of every top-level instruction
 * @param limits - The accepting path's caps
 * @returns The first violation, or undefined when the budget is acceptable
 */
export function checkTransactionV1Budget(
  config: TransactionV1Config,
  programAddresses: readonly string[],
  limits: TransactionV1BudgetLimits,
): TransactionV1BudgetViolation | undefined {
  const priorityBits = config.mask & TRANSACTION_CONFIG_PRIORITY_FEE_LAMPORTS_BIT_MASK;
  if (priorityBits !== 0 && priorityBits !== TRANSACTION_CONFIG_PRIORITY_FEE_LAMPORTS_BIT_MASK) {
    return "priority_fee_bits";
  }
  if (config.mask & TRANSACTION_CONFIG_HEAP_SIZE_BIT_MASK) return "heap_size";
  if (programAddresses.some(program => program === COMPUTE_BUDGET_PROGRAM_ADDRESS)) {
    return "compute_budget_instruction";
  }
  if (config.computeUnitLimit === undefined) return "compute_unit_limit_missing";
  if (limits.maxComputeUnits !== undefined && config.computeUnitLimit > limits.maxComputeUnits) {
    return "compute_unit_limit_too_high";
  }
  if (config.loadedAccountsDataSizeLimit === undefined) {
    return "loaded_accounts_data_size_limit_missing";
  }
  const fee = config.priorityFeeLamports ?? 0n;
  if (fee * 1_000_000n > BigInt(limits.maxPriceMicroLamports) * BigInt(config.computeUnitLimit)) {
    return "priority_fee_too_high";
  }
  return undefined;
}
