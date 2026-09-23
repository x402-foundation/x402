import type { Network, SettleResponse } from "@x402/core/types";
import type { PendingSettlementStore } from "@x402/core/facilitator";
import {
  Client,
  ContractExecuteTransaction,
  ContractCallQuery,
  Hbar,
  StatusError,
  TransactionRecordQuery,
  type TransactionRecord,
} from "@hiero-ledger/sdk";
import {
  bytesToHex,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hexToBytes,
} from "viem";
import { batchSettlementABI, hederaAllowanceDepositCollectorABI } from "./abi";
import { contractIdFromEvmAddress } from "./addresses";
import { ErrInvalidTransactionState, ErrSettlementPending } from "./errors";

/** Log emitted by a Hedera contract execution, in EVM shape (for `parseEventLogs`). */
export type HederaContractLog = {
  address: `0x${string}`;
  topics: [`0x${string}`, ...`0x${string}`[]] | [];
  data: `0x${string}`;
};

/** Read (`eth_call`-style) request. */
export type HederaContractReadArgs = {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  /** Simulated `msg.sender`; defaults to the reader's configured sender. */
  from?: `0x${string}`;
};

/** Write request executed as a `ContractExecuteTransaction`. */
export type HederaContractExecuteArgs = {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  gas: bigint;
};

/** Outcome of a confirmed contract execution. */
export type HederaContractExecutionResult = {
  /** Hedera transaction id (`0.0.x@sec.nanos`). */
  transactionId: string;
  logs: HederaContractLog[];
  gasUsed?: bigint;
};

/** Thrown when a contract call reverted (simulation or execution). */
export class HederaContractRevertError extends Error {
  readonly status: string;
  readonly data?: `0x${string}`;
  readonly transactionId?: string;

  /**
   * Creates a revert error.
   *
   * @param status - Hedera status or HTTP status text.
   * @param message - Human-readable reason (decoded custom error when possible).
   * @param data - Raw revert data when available.
   * @param transactionId - Transaction id when the revert happened on-chain.
   */
  constructor(status: string, message: string, data?: `0x${string}`, transactionId?: string) {
    super(message);
    this.name = "HederaContractRevertError";
    this.status = status;
    this.data = data;
    this.transactionId = transactionId;
  }
}

/** Thrown when a transaction was submitted but its outcome could not be established. */
export class HederaPendingError extends Error {
  readonly transactionId: string;

  /**
   * Creates a pending error.
   *
   * @param transactionId - Submitted transaction id.
   * @param cause - Underlying error.
   */
  constructor(transactionId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "HederaPendingError";
    this.transactionId = transactionId;
  }
}

/**
 * Decodes revert data against the known ABIs into a readable message.
 *
 * @param data - Raw revert data.
 * @returns Decoded `Error(reason)` / custom error name, or the hex data itself.
 */
export function decodeRevertReason(data: `0x${string}` | undefined): string {
  if (!data || data === "0x") return "execution reverted";
  for (const abi of [batchSettlementABI, hederaAllowanceDepositCollectorABI]) {
    try {
      const decoded = decodeErrorResult({ abi, data });
      const args = decoded.args ? ` (${decoded.args.map(String).join(", ")})` : "";
      return `${decoded.errorName}${args}`;
    } catch {
      // try next ABI
    }
  }
  return `execution reverted: ${data}`;
}

/** Reader backed by the Mirror Node `contracts/call` endpoint. */
export interface HederaContractReader {
  readContract(args: HederaContractReadArgs): Promise<unknown>;
  /** Runs the call and throws {@link HederaContractRevertError} when it would revert. */
  simulateContract(args: HederaContractReadArgs): Promise<void>;
}

/** Options for {@link createMirrorNodeContractReader}. */
export type MirrorNodeContractReaderOptions = {
  mirrorNodeUrl: string;
  /** Default simulated sender. */
  from?: `0x${string}`;
  /**
   * Optional consensus-node fallback (`ContractCallQuery`, paid) used when the Mirror Node
   * rejects a call as unsupported. Provide a client factory to enable it.
   */
  fallbackClient?: () => Client;
};

type MirrorCallError = {
  _status?: { messages?: { message?: string; detail?: string; data?: string }[] };
};

/**
 * Creates a contract reader that executes `eth_call`-style requests against the Mirror Node.
 *
 * @param options - Mirror Node URL and defaults.
 * @returns Reader instance.
 */
export function createMirrorNodeContractReader(
  options: MirrorNodeContractReaderOptions,
): HederaContractReader {
  const call = async (args: HederaContractReadArgs): Promise<`0x${string}`> => {
    const data = encodeFunctionData({
      abi: args.abi,
      functionName: args.functionName,
      args: args.args as unknown[],
    });
    const from = args.from ?? options.from;
    const response = await fetch(`${options.mirrorNodeUrl}/api/v1/contracts/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: args.address,
        data,
        block: "latest",
        estimate: false,
        ...(from ? { from } : {}),
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { result?: string } | MirrorCallError;

    if (response.ok && "result" in body && typeof body.result === "string") {
      return body.result as `0x${string}`;
    }

    const messages = (body as MirrorCallError)._status?.messages ?? [];
    const first = messages[0];
    const revertData =
      first?.data && /^0x[0-9a-fA-F]*$/.test(first.data)
        ? (first.data as `0x${string}`)
        : undefined;
    const status = first?.message ?? `HTTP ${response.status}`;

    if (options.fallbackClient && /not supported|unsupported/i.test(JSON.stringify(body))) {
      return consensusCall(options.fallbackClient(), args, data);
    }

    const reason = revertData
      ? decodeRevertReason(revertData)
      : first?.detail || status || "contract call failed";
    throw new HederaContractRevertError(status, reason, revertData);
  };

  return {
    async readContract(args) {
      const result = await call(args);
      return decodeFunctionResult({
        abi: args.abi,
        functionName: args.functionName,
        data: result,
      });
    },
    async simulateContract(args) {
      await call(args);
    },
  };
}

/**
 * Consensus-node `ContractCallQuery` fallback.
 *
 * @param client - Hiero SDK client with an operator (pays the query fee).
 * @param args - Read arguments.
 * @param data - Encoded calldata.
 * @returns Raw return data.
 */
async function consensusCall(
  client: Client,
  args: HederaContractReadArgs,
  data: `0x${string}`,
): Promise<`0x${string}`> {
  const result = await new ContractCallQuery()
    .setContractId(contractIdFromEvmAddress(args.address))
    .setGas(2_000_000)
    .setFunctionParameters(hexToBytes(data))
    .execute(client);
  if (result.errorMessage) {
    const revertData = /^0x/.test(result.errorMessage)
      ? (result.errorMessage as `0x${string}`)
      : undefined;
    throw new HederaContractRevertError(
      "CONTRACT_REVERT_EXECUTED",
      revertData ? decodeRevertReason(revertData) : result.errorMessage,
      revertData,
    );
  }
  return bytesToHex(result.bytes);
}

/** Executor that submits contract calls as HAPI `ContractExecuteTransaction`s. */
export interface HederaContractExecutor {
  executeContract(args: HederaContractExecuteArgs): Promise<HederaContractExecutionResult>;
}

/** Options for {@link createHieroContractExecutor}. */
export type HieroContractExecutorOptions = {
  /** Factory returning a Hiero client with the facilitator operator set. */
  buildClient: () => Client;
  /** Max HBAR fee per contract execution (default 20). Bounds the facilitator's gas exposure. */
  maxTransactionFeeHbar?: number;
  /** Close the client after each execution (default true when `buildClient` creates a new one). */
  closeClient?: boolean;
};

/**
 * Creates an executor backed by the Hiero SDK. The operator account pays the fee and is the
 * EVM `msg.sender`; results are read from the transaction record (consensus, not Mirror Node).
 *
 * @param options - Client factory.
 * @returns Executor instance.
 */
export function createHieroContractExecutor(
  options: HieroContractExecutorOptions,
): HederaContractExecutor {
  const closeClient = options.closeClient ?? true;
  return {
    async executeContract(args) {
      const data = encodeFunctionData({
        abi: args.abi,
        functionName: args.functionName,
        args: args.args as unknown[],
      });
      const client = options.buildClient();
      try {
        const tx = new ContractExecuteTransaction()
          .setContractId(contractIdFromEvmAddress(args.address))
          .setGas(Number(args.gas))
          .setMaxTransactionFee(new Hbar(options.maxTransactionFeeHbar ?? 20))
          .setFunctionParameters(hexToBytes(data));
        const response = await tx.execute(client);
        const transactionId = response.transactionId.toString();

        let record: TransactionRecord;
        try {
          record = await response.getRecord(client);
        } catch (error) {
          if (error instanceof StatusError) {
            throw await revertFromFailedRecord(client, transactionId, error);
          }
          throw new HederaPendingError(transactionId, error);
        }
        return toExecutionResult(transactionId, record);
      } finally {
        if (closeClient) client.close();
      }
    },
  };
}

/**
 * Builds a {@link HederaContractRevertError} for a transaction whose receipt status was not SUCCESS,
 * reading the revert data from the record when available.
 *
 * @param client - Hiero client.
 * @param transactionId - Failed transaction id.
 * @param error - The receipt status error.
 * @returns Revert error with decoded reason.
 */
async function revertFromFailedRecord(
  client: Client,
  transactionId: string,
  error: StatusError,
): Promise<HederaContractRevertError> {
  const status = error.status.toString();
  try {
    const record = await new TransactionRecordQuery()
      .setTransactionId(transactionId)
      .setValidateReceiptStatus(false)
      .execute(client);
    const errorMessage = record.contractFunctionResult?.errorMessage ?? undefined;
    const revertData =
      errorMessage && /^0x[0-9a-fA-F]*$/.test(errorMessage)
        ? (errorMessage as `0x${string}`)
        : undefined;
    const reason = revertData ? decodeRevertReason(revertData) : (errorMessage ?? status);
    return new HederaContractRevertError(status, `${status}: ${reason}`, revertData, transactionId);
  } catch {
    return new HederaContractRevertError(status, status, undefined, transactionId);
  }
}

/**
 * Converts a transaction record into an {@link HederaContractExecutionResult}.
 *
 * @param transactionId - Transaction id.
 * @param record - Confirmed transaction record.
 * @returns Execution result with EVM-shaped logs.
 */
function toExecutionResult(
  transactionId: string,
  record: TransactionRecord,
): HederaContractExecutionResult {
  const fnResult = record.contractFunctionResult;
  const logs: HederaContractLog[] = (fnResult?.logs ?? []).map(log => ({
    address: getAddress(`0x${log.contractId.toEvmAddress().replace(/^0x/, "")}`),
    topics: log.topics.map(t => bytesToHex(t)) as HederaContractLog["topics"],
    data: bytesToHex(log.data),
  }));
  return {
    transactionId,
    logs,
    gasUsed: fnResult ? BigInt(fnResult.gasUsed.toString()) : undefined,
  };
}

/** Optional behavior for {@link runContractSettlement}. */
export interface RunContractSettlementOptions {
  /** Error reason for terminal failures (revert / submission failure). */
  failedStatusReason?: string;
  /** Settled amount attached on success when `onSuccess` is omitted. */
  amount?: string;
  /** Builds the success response from the execution result when set. */
  onSuccess?: (result: HederaContractExecutionResult) => SettleResponse | Promise<SettleResponse>;
}

/**
 * Runs a contract execution and maps its outcome to a {@link SettleResponse}: a revert or
 * submission failure is terminal, an undetermined outcome after submission is `settlement_pending`
 * with the transaction id so the caller can reconcile.
 *
 * @param execute - Thunk performing the execution.
 * @param network - Network identifier for the response.
 * @param payer - Payer identifier for the response.
 * @param options - Success/failure shaping.
 * @returns Settle response.
 */
export async function runContractSettlement(
  execute: () => Promise<HederaContractExecutionResult>,
  network: Network,
  payer: string | undefined,
  options: RunContractSettlementOptions = {},
): Promise<SettleResponse> {
  const { failedStatusReason = ErrInvalidTransactionState, amount, onSuccess } = options;
  let result: HederaContractExecutionResult;
  try {
    result = await execute();
  } catch (error) {
    if (error instanceof HederaPendingError) {
      return {
        success: false,
        errorReason: ErrSettlementPending,
        errorMessage: truncate(error.message),
        transaction: error.transactionId,
        network,
        payer,
      };
    }
    return {
      success: false,
      errorReason: failedStatusReason,
      errorMessage: truncate(error instanceof Error ? error.message : String(error)),
      transaction: error instanceof HederaContractRevertError ? (error.transactionId ?? "") : "",
      network,
      payer,
    };
  }

  try {
    if (onSuccess) {
      return await onSuccess(result);
    }
    return {
      success: true,
      transaction: result.transactionId,
      network,
      payer,
      ...(amount !== undefined ? { amount } : {}),
    };
  } catch (error) {
    return {
      success: false,
      errorReason: ErrSettlementPending,
      errorMessage: truncate(error instanceof Error ? error.message : String(error)),
      transaction: result.transactionId,
      network,
      payer,
    };
  }
}

/**
 * Wraps a settle attempt with `PendingSettlementStore` bookkeeping (see the EVM implementation):
 * only a retryable `settlement_pending` failure carrying a transaction id is recorded.
 *
 * @param store - Pending-settlement store.
 * @param pendingKey - Deterministic key for this payload; when undefined the store is untouched.
 * @param settle - Thunk performing the settle attempt.
 * @param nonRetryableReason - Reason reported if persisting a pending entry fails.
 * @returns The settle result.
 */
export async function withPendingSettlementStore(
  store: PendingSettlementStore,
  pendingKey: string | undefined,
  settle: () => Promise<SettleResponse>,
  nonRetryableReason: string = ErrInvalidTransactionState,
): Promise<SettleResponse> {
  const result = await settle();
  if (!pendingKey) {
    return result;
  }

  const isPending =
    !result.success && result.errorReason === ErrSettlementPending && !!result.transaction;

  if (isPending) {
    try {
      await store.set(pendingKey, result.transaction as string);
    } catch (storeError) {
      return {
        ...result,
        errorReason: nonRetryableReason,
        errorMessage: `settlement_pending, but failed to persist for retry: ${
          storeError instanceof Error ? storeError.message : String(storeError)
        }`,
      };
    }
    return result;
  }

  try {
    await store.delete(pendingKey);
  } catch {
    // Best-effort cleanup.
  }
  return result;
}

/** Matches the truncation length used by the other SDKs. */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Bounds raw error text before it is placed in a settle/verify message.
 *
 * @param message - Raw error text.
 * @returns Truncated message.
 */
export function truncate(message: string): string {
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}
