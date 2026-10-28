import {
  AccountId,
  Client,
  ContractExecuteTransaction,
  ContractId,
  PrecheckStatusError,
  PrivateKey,
  Status,
  TransactionId,
  type TransactionResponse,
} from "@hiero-ledger/sdk";
import { errorMessage, isJsonObject } from "./internal";
import { mirrorNodeUrlForNetwork } from "./preflight";
import type {
  FacilitatorHederaSigner,
  HederaContractCallSimulationResult,
  HederaTokenCustomFees,
} from "./signer";
import type {
  HederaContractLog,
  HederaNftTransferEntry,
  HederaTransactionRecord,
  HederaTransactionRecordEntry,
  HederaTransferEntry,
} from "./types";
import { isValidHexBytes } from "./utils";

/**
 * Upper bound on a single Mirror Node request, in milliseconds.
 */
const MIRROR_NODE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Mirror Node endpoint configuration for the default `transferExecutor`
 * signer capabilities.
 */
export type HederaMirrorNodeConfig = {
  /**
   * Mirror Node REST API base URL. A string applies to every network; a
   * record is keyed by CAIP-2 network. Networks without an entry use the
   * package's public Mirror Node for that network.
   */
  mirrorNodeUrl?: string | Partial<Record<string, string>>;
};

/**
 * Default bound on waiting for a transaction record to reach the Mirror Node.
 */
const DEFAULT_RECORD_TIMEOUT_MS = 20_000;

/**
 * Default delay between Mirror Node record lookups while the record is missing.
 */
const DEFAULT_RECORD_POLL_INTERVAL_MS = 1_000;

/**
 * Hedera status names a Mirror Node contract call reports in its error
 * messages, e.g. `CONTRACT_REVERT_EXECUTED` or `INSUFFICIENT_TOKEN_BALANCE`.
 */
const STATUS_TOKEN_REGEX = /^[A-Z][A-Z0-9_]*$/;

/**
 * Statuses that reject the simulation request itself rather than the call.
 * `PAYER_ACCOUNT_NOT_FOUND` means the facilitator's own `from` is unknown.
 */
const REQUEST_REJECTION_STATUSES: ReadonlySet<string> = new Set(["PAYER_ACCOUNT_NOT_FOUND"]);

/**
 * Most revert-data hex digits a simulation reason carries; longer data is
 * truncated and marked.
 */
const REVERT_DATA_MAX_HEX_CHARS = 1_024;

/**
 * Configuration for the default `getTransactionRecord` capability.
 */
export type HederaTransactionRecordConfig = HederaMirrorNodeConfig & {
  /**
   * How long to wait for the record to reach the Mirror Node before
   * reporting it unavailable, in milliseconds. Defaults to 20 000.
   */
  timeoutMs?: number;
  /**
   * Delay between lookups while the record is missing, in milliseconds.
   * Defaults to 1 000.
   */
  pollIntervalMs?: number;
};

/**
 * Account fields `resolveEvmAddress` reads from the Mirror Node `/accounts/{id}` endpoint.
 */
type MirrorEvmAccount = {
  account?: unknown;
  evm_address?: unknown;
};

/**
 * Status and parsed body of a Mirror Node response.
 */
type MirrorResponse = {
  /**
   * Request method and URL, for error messages.
   */
  request: string;
  status: number;
  ok: boolean;
  /**
   * Parsed JSON body, or undefined when the body is not JSON.
   */
  body: unknown;
};

/**
 * Resolves the Mirror Node base URL for a network from the configuration.
 *
 * @param config - Mirror Node configuration
 * @param network - CAIP-2 network identifier
 * @returns Mirror Node REST API base URL, without a trailing slash
 */
function mirrorNodeBaseUrl(config: HederaMirrorNodeConfig, network: string): string {
  const configured = config.mirrorNodeUrl;
  const baseUrl =
    typeof configured === "string"
      ? configured
      : (configured?.[network] ?? mirrorNodeUrlForNetwork(network));
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Sends a Mirror Node request with a bounded timeout, keeping the HTTP status.
 * A network error or timeout throws.
 *
 * @param url - Fully-qualified Mirror Node URL
 * @param init - Optional request method, headers and body
 * @returns The response status and its parsed JSON body
 */
async function mirrorFetch(url: string, init: RequestInit = {}): Promise<MirrorResponse> {
  const request = `${init.method ?? "GET"} ${url}`;
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(MIRROR_NODE_REQUEST_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    throw new Error(`Mirror Node ${request} failed: ${errorMessage(error)}`, { cause: error });
  }
  return { request, status: response.status, ok: response.ok, body: parseJson(text) };
}

/**
 * Parses a JSON response body.
 *
 * @param text - Raw response body
 * @returns The parsed value, or undefined when the body is not JSON
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Returns the JSON object body of a successful Mirror Node response.
 *
 * @param response - Mirror Node response
 * @returns The JSON object body
 * @throws {Error} When the status is not 2xx or the body is not a JSON object
 */
function requireJsonObject(response: MirrorResponse): Record<string, unknown> {
  if (!response.ok) {
    throw new Error(`Mirror Node ${response.request} returned HTTP ${response.status}`);
  }
  if (!isJsonObject(response.body)) {
    throw new Error(
      `Mirror Node ${response.request} returned HTTP ${response.status} without a JSON object body`,
    );
  }
  return response.body;
}

/**
 * Returns true when the Mirror Node has no entity for the requested id: it
 * answers 404 for an unknown id and 400 for one it cannot parse.
 *
 * @param response - Mirror Node response to an entity lookup
 * @returns Whether the entity does not exist
 */
function isNotFound(response: MirrorResponse): boolean {
  return response.status === 404 || response.status === 400;
}

/**
 * Builds a `resolveEvmAddress` implementation backed by the Mirror Node
 * `/api/v1/accounts/{id}` endpoint, whose `evm_address` is the account's
 * alias when it has one and its long-zero address otherwise. An id the Mirror
 * Node does not know or cannot parse resolves undefined.
 *
 * @param config - Optional Mirror Node configuration
 * @returns A function suitable for `FacilitatorHederaSigner.resolveEvmAddress`
 */
export function createHederaResolveEvmAddress(
  config: HederaMirrorNodeConfig = {},
): NonNullable<FacilitatorHederaSigner["resolveEvmAddress"]> {
  return async ({ account, network }) => {
    const baseUrl = mirrorNodeBaseUrl(config, network);
    const response = await mirrorFetch(`${baseUrl}/api/v1/accounts/${encodeURIComponent(account)}`);
    if (isNotFound(response)) {
      return undefined;
    }
    const body: MirrorEvmAccount = requireJsonObject(response);
    if (typeof body.evm_address !== "string" || body.evm_address.length === 0) {
      return undefined;
    }
    if (typeof body.account !== "string") {
      throw new Error(`Mirror Node ${response.request} returned no account id`);
    }
    return { accountId: body.account, evmAddress: body.evm_address.toLowerCase() };
  };
}

/**
 * Counts the entries of one custom fee list. A list the Mirror Node omits
 * (royalty fees on a fungible token, fractional fees on an NFT) counts zero.
 *
 * @param fees - The `custom_fees` object of a token
 * @param kind - Name of the fee list
 * @param request - Request method and URL, for error messages
 * @returns Number of fees of that kind
 */
function countFees(fees: Record<string, unknown>, kind: string, request: string): number {
  const list = fees[kind];
  if (list === undefined || list === null) {
    return 0;
  }
  if (!Array.isArray(list)) {
    throw new Error(`Mirror Node ${request} returned a non-array custom_fees.${kind}`);
  }
  return list.length;
}

/**
 * Builds a `getTokenCustomFees` implementation backed by the Mirror Node
 * `/api/v1/tokens/{tokenId}` endpoint. An id the Mirror Node does not know or
 * cannot parse, or a non-fungible token, resolves undefined.
 *
 * @param config - Optional Mirror Node configuration
 * @returns A function suitable for `FacilitatorHederaSigner.getTokenCustomFees`
 */
export function createHederaGetTokenCustomFees(
  config: HederaMirrorNodeConfig = {},
): NonNullable<FacilitatorHederaSigner["getTokenCustomFees"]> {
  return async ({ tokenId, network }): Promise<HederaTokenCustomFees | undefined> => {
    const baseUrl = mirrorNodeBaseUrl(config, network);
    const response = await mirrorFetch(`${baseUrl}/api/v1/tokens/${encodeURIComponent(tokenId)}`);
    if (isNotFound(response)) {
      return undefined;
    }
    const token = requireJsonObject(response);
    const type = requireString(token.type, "type", response.request);
    if (type !== "FUNGIBLE_COMMON") {
      return undefined;
    }
    const fees = token.custom_fees;
    if (!isJsonObject(fees)) {
      throw new Error(`Mirror Node ${response.request} returned no custom_fees`);
    }
    return {
      fixedFeeCount: countFees(fees, "fixed_fees", response.request),
      fractionalFeeCount: countFees(fees, "fractional_fees", response.request),
      royaltyFeeCount: countFees(fees, "royalty_fees", response.request),
    };
  };
}

/**
 * Builds a `simulateContractCall` implementation backed by the Mirror Node
 * `POST /api/v1/contracts/call` endpoint, which runs a full, state-changing
 * simulation (HTS system-contract calls included) against the latest state.
 *
 * The call never carries a `value`. A revert or failed execution resolves
 * `{ reverted: true }`; a transport failure, throttle, server error,
 * non-JSON body or a rejection caused by the request itself throws.
 *
 * @param config - Optional Mirror Node configuration
 * @returns A function suitable for `FacilitatorHederaSigner.simulateContractCall`
 */
export function createHederaSimulateContractCall(
  config: HederaMirrorNodeConfig = {},
): NonNullable<FacilitatorHederaSigner["simulateContractCall"]> {
  return async ({ network, from, to, data, gas, estimate }) => {
    const baseUrl = mirrorNodeBaseUrl(config, network);
    const response = await mirrorFetch(`${baseUrl}/api/v1/contracts/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ block: "latest", data, estimate, from, gas, to }),
    });
    if (response.status === 400) {
      return classifyRejectedCall(response);
    }
    const body = requireJsonObject(response);
    const result: HederaContractCallSimulationResult = { reverted: false };
    if (estimate) {
      result.gasEstimate = parseGasEstimate(body.result, response.request);
    }
    return result;
  };
}

/**
 * Classifies an HTTP 400 from `contracts/call`. The first message names the
 * execution status of a reverted or failed call; anything else is a
 * rejection of the request and throws.
 *
 * @param response - The HTTP 400 response
 * @returns The revert, with its status and decoded detail as the reason, or
 *   its status and (capped) revert data hex when there is no detail
 * @throws {Error} When the 400 is not an execution failure
 */
function classifyRejectedCall(response: MirrorResponse): HederaContractCallSimulationResult {
  const status = isJsonObject(response.body) ? response.body._status : undefined;
  const messages = isJsonObject(status) ? status.messages : undefined;
  const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
  const message = isJsonObject(first) ? first.message : undefined;
  if (
    typeof message !== "string" ||
    !STATUS_TOKEN_REGEX.test(message) ||
    REQUEST_REJECTION_STATUSES.has(message)
  ) {
    const shown = typeof message === "string" ? `: ${message}` : "";
    throw new Error(`Mirror Node ${response.request} returned HTTP 400${shown}`);
  }
  const detail = isJsonObject(first) && typeof first.detail === "string" ? first.detail : "";
  if (detail) {
    return { reverted: true, reason: `${message}: ${detail}` };
  }
  const data = isJsonObject(first) && typeof first.data === "string" ? first.data : "";
  const hex = data.replace(/^0x/i, "");
  if (!hex) {
    return { reverted: true, reason: message };
  }
  const shown =
    hex.length > REVERT_DATA_MAX_HEX_CHARS
      ? `${hex.slice(0, REVERT_DATA_MAX_HEX_CHARS)}... (truncated)`
      : hex;
  return { reverted: true, reason: `${message}: revert data 0x${shown}` };
}

/**
 * Parses the hex `result` of an `estimate: true` contract call.
 *
 * @param result - The `result` field of the response
 * @param request - Request method and URL, for error messages
 * @returns The gas estimate
 */
function parseGasEstimate(result: unknown, request: string): number {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result)) {
    throw new Error(`Mirror Node ${request} returned an invalid gas estimate`);
  }
  const estimate = Number(BigInt(result));
  if (!Number.isSafeInteger(estimate)) {
    throw new Error(`Mirror Node ${request} returned an invalid gas estimate`);
  }
  return estimate;
}

/**
 * Decodes 0x-hex calldata into bytes.
 *
 * @param calldata - 0x-prefixed, even-length hex
 * @returns The calldata bytes
 * @throws {Error} When `calldata` is not 0x-prefixed even-length hex
 */
function calldataBytes(calldata: string): Uint8Array {
  if (!isValidHexBytes(calldata)) {
    throw new Error("contract calldata must be 0x-prefixed, even-length hex");
  }
  return Buffer.from(calldata.slice(2), "hex");
}

/**
 * Builds a `submitContractExecute` implementation backed by the Hiero SDK.
 *
 * Signs a `ContractExecuteTransaction` with the fee payer's key and submits
 * it without a payable amount. It throws only when nothing can have reached
 * consensus: a failure before submission, or a node's precheck rejection.
 * Otherwise it resolves with the transaction id: a timeout or transport error
 * can follow a node accepting the transaction, and a `DUPLICATE_TRANSACTION`
 * precheck means one did, so those leave `receiptStatus` undefined, as does a
 * failed receipt query. The receipt status is read without validation, so a
 * non-SUCCESS status is returned rather than thrown.
 *
 * @param buildClient - Factory that produces an SDK client for a given CAIP-2 network
 * @param feePayerKey - Private key of the fee payer account that signs the transaction
 * @returns A function suitable for `FacilitatorHederaSigner.submitContractExecute`
 */
export function createHederaSubmitContractExecute(
  buildClient: (network: string) => Client,
  feePayerKey: PrivateKey,
): NonNullable<FacilitatorHederaSigner["submitContractExecute"]> {
  return async ({ network, feePayer, contractId, functionParameters, gas }) => {
    const client = buildClient(network);
    try {
      const transactionId = TransactionId.generate(AccountId.fromString(feePayer));
      const tx = new ContractExecuteTransaction()
        .setTransactionId(transactionId)
        .setContractId(ContractId.fromString(contractId))
        .setGas(gas)
        .setFunctionParameters(calldataBytes(functionParameters));
      tx.freezeWith(client);
      const signed = await tx.sign(feePayerKey);
      let response: TransactionResponse;
      try {
        response = await signed.execute(client);
      } catch (error) {
        if (error instanceof PrecheckStatusError && error.status !== Status.DuplicateTransaction) {
          throw error;
        }
        return { transactionId: transactionId.toString(), receiptStatus: undefined };
      }
      const broadcastId = response.transactionId.toString();
      try {
        const receipt = await response
          .getReceiptQuery(client)
          .setValidateStatus(false)
          .execute(client);
        return { transactionId: broadcastId, receiptStatus: receipt.status.toString() };
      } catch {
        // Broadcast already happened, so the id is still reported.
        return { transactionId: broadcastId, receiptStatus: undefined };
      }
    } finally {
      client.close();
    }
  };
}

/**
 * Builds a `getTransactionRecord` implementation backed by the Mirror Node
 * `/api/v1/transactions/{id}` endpoint, for the parent and child records, and
 * `/api/v1/contracts/results/{id}`, whose logs include those of nested calls.
 *
 * While either endpoint answers 404 it polls every `pollIntervalMs` until
 * `timeoutMs` has passed, then resolves undefined. Any other failure throws,
 * as does an amount that does not fit a JavaScript safe integer.
 *
 * @param config - Optional Mirror Node and polling configuration
 * @returns A function suitable for `FacilitatorHederaSigner.getTransactionRecord`
 * @throws {Error} When `timeoutMs` or `pollIntervalMs` is not a finite positive number
 */
export function createHederaGetTransactionRecord(
  config: HederaTransactionRecordConfig = {},
): NonNullable<FacilitatorHederaSigner["getTransactionRecord"]> {
  const timeoutMs = requirePositiveDuration(
    config.timeoutMs ?? DEFAULT_RECORD_TIMEOUT_MS,
    "timeoutMs",
  );
  const pollIntervalMs = requirePositiveDuration(
    config.pollIntervalMs ?? DEFAULT_RECORD_POLL_INTERVAL_MS,
    "pollIntervalMs",
  );
  return async ({ transactionId, network }) => {
    const baseUrl = mirrorNodeBaseUrl(config, network);
    const mirrorId = encodeURIComponent(toMirrorTransactionId(transactionId));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = await readTransactionRecord(baseUrl, mirrorId, transactionId);
      if (record) {
        return record;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return undefined;
      }
      await delay(Math.min(pollIntervalMs, remaining));
    }
  };
}

/**
 * Returns a duration option when it is a finite positive number, so the record
 * wait stays bounded.
 *
 * @param value - Duration in milliseconds
 * @param option - Option name, for the error message
 * @returns The duration
 * @throws {Error} When `value` is not a finite positive number
 */
function requirePositiveDuration(value: number, option: string): number {
  // Operators may pass untyped JSON, so the type is checked at runtime too.
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${option} must be a finite positive number of milliseconds`);
  }
  return value;
}

/**
 * Converts an SDK transaction id (`0.0.x@seconds.nanos`) to the Mirror Node
 * form (`0.0.x-seconds-nanos`, nanos zero-padded to nine digits).
 *
 * @param transactionId - Transaction id in the SDK `@` form
 * @returns The Mirror Node transaction id
 * @throws {Error} When `transactionId` is not in the SDK `@` form
 */
function toMirrorTransactionId(transactionId: string): string {
  const match = /^(\d+\.\d+\.\d+)@(\d+)\.(\d{1,9})$/.exec(transactionId);
  if (!match) {
    throw new Error(`Invalid Hedera transaction id: ${transactionId}`);
  }
  return `${match[1]}-${match[2]}-${match[3].padStart(9, "0")}`;
}

/**
 * Resolves after `ms` milliseconds.
 *
 * @param ms - Delay in milliseconds
 * @returns A promise that resolves after the delay
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reads a transaction record and its contract logs once.
 *
 * @param baseUrl - Mirror Node REST API base URL
 * @param mirrorId - URL-encoded Mirror Node transaction id
 * @param transactionId - Transaction id in the SDK `@` form
 * @returns The record, or undefined when the Mirror Node does not have it yet
 */
async function readTransactionRecord(
  baseUrl: string,
  mirrorId: string,
  transactionId: string,
): Promise<HederaTransactionRecord | undefined> {
  const transactions = await mirrorFetch(`${baseUrl}/api/v1/transactions/${mirrorId}`);
  if (transactions.status === 404) {
    return undefined;
  }
  const entries = requireArray(
    requireJsonObject(transactions).transactions,
    "transactions",
    transactions.request,
  );
  const parent = entries.find(
    item => isJsonObject(item) && item.nonce === 0 && item.scheduled === false,
  );
  if (!isJsonObject(parent)) {
    throw new Error(`Mirror Node ${transactions.request} returned no parent transaction`);
  }
  const children = entries.filter(
    (item): item is Record<string, unknown> =>
      isJsonObject(item) &&
      typeof item.parent_consensus_timestamp === "string" &&
      item.parent_consensus_timestamp === parent.consensus_timestamp,
  );

  const result = await mirrorFetch(`${baseUrl}/api/v1/contracts/results/${mirrorId}`);
  if (result.status === 404) {
    return undefined;
  }
  const logs = requireArray(requireJsonObject(result).logs, "logs", result.request);

  const parentEntry = toRecordEntry(parent, transactions.request);
  return {
    transactionId,
    status: parentEntry.result,
    transactionFee: parentEntry.chargedFee,
    parent: parentEntry,
    children: children.map(child => toRecordEntry(child, transactions.request)),
    logs: logs.map(log => toContractLog(log, result.request)),
  };
}

/**
 * Returns `value` when it is an array.
 *
 * @param value - Candidate value
 * @param field - Field name, for error messages
 * @param request - Request method and URL, for error messages
 * @returns The array
 * @throws {Error} When `value` is not an array
 */
function requireArray(value: unknown, field: string, request: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Mirror Node ${request} returned a non-array ${field}`);
  }
  return value;
}

/**
 * Returns `value` when it is a string.
 *
 * @param value - Candidate value
 * @param field - Field name, for error messages
 * @param request - Request method and URL, for error messages
 * @returns The string
 * @throws {Error} When `value` is not a string
 */
function requireString(value: unknown, field: string, request: string): string {
  if (typeof value !== "string") {
    throw new Error(`Mirror Node ${request} returned a non-string ${field}`);
  }
  return value;
}

/**
 * Converts a JSON integer to a base-10 string, refusing values that JSON
 * parsing may have rounded.
 *
 * @param value - Candidate integer
 * @param field - Field name, for error messages
 * @param request - Request method and URL, for error messages
 * @returns The integer as a base-10 string
 * @throws {Error} When `value` is not a safe integer
 */
function safeIntegerString(value: unknown, field: string, request: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Mirror Node ${request} returned ${field} that is not a safe integer`);
  }
  return String(value);
}

/**
 * Maps a Mirror Node `{ account, amount }` list.
 *
 * @param value - The list
 * @param field - Field name, for error messages
 * @param request - Request method and URL, for error messages
 * @returns The normalized transfers
 */
function toTransfers(value: unknown, field: string, request: string): HederaTransferEntry[] {
  return requireArray(value, field, request).map(item => {
    const transfer = isJsonObject(item) ? item : {};
    return {
      accountId: requireString(transfer.account, `${field}.account`, request),
      amount: safeIntegerString(transfer.amount, `${field}.amount`, request),
    };
  });
}

/**
 * Maps a Mirror Node transaction entry to a normalized record entry.
 *
 * @param entry - Mirror Node transaction entry
 * @param request - Request method and URL, for error messages
 * @returns The record entry
 */
function toRecordEntry(
  entry: Record<string, unknown>,
  request: string,
): HederaTransactionRecordEntry {
  const tokenTransfers: Record<string, HederaTransferEntry[]> = {};
  for (const item of requireArray(entry.token_transfers, "token_transfers", request)) {
    const transfer = isJsonObject(item) ? item : {};
    const tokenId = requireString(transfer.token_id, "token_transfers.token_id", request);
    const [mapped] = toTransfers([transfer], "token_transfers", request);
    (tokenTransfers[tokenId] ??= []).push(mapped);
  }
  const nftTransfers = requireArray(entry.nft_transfers, "nft_transfers", request).map(
    (item): HederaNftTransferEntry => {
      const transfer = isJsonObject(item) ? item : {};
      return {
        tokenId: requireString(transfer.token_id, "nft_transfers.token_id", request),
        serialNumber: safeIntegerString(
          transfer.serial_number,
          "nft_transfers.serial_number",
          request,
        ),
        senderAccountId: nullableString(
          transfer.sender_account_id,
          "nft_transfers.sender_account_id",
          request,
        ),
        receiverAccountId: nullableString(
          transfer.receiver_account_id,
          "nft_transfers.receiver_account_id",
          request,
        ),
      };
    },
  );
  return {
    result: requireString(entry.result, "result", request),
    chargedFee: safeIntegerString(entry.charged_tx_fee, "charged_tx_fee", request),
    hbarTransfers: toTransfers(entry.transfers, "transfers", request),
    tokenTransfers,
    nftTransfers,
    stakingRewardTransfers: toTransfers(
      entry.staking_reward_transfers,
      "staking_reward_transfers",
      request,
    ),
  };
}

/**
 * Returns `value` when it is a string or null.
 *
 * @param value - Candidate value
 * @param field - Field name, for error messages
 * @param request - Request method and URL, for error messages
 * @returns The string, or null
 */
function nullableString(value: unknown, field: string, request: string): string | null {
  return value === null ? null : requireString(value, field, request);
}

/**
 * Maps a Mirror Node contract log, lowercasing its hex fields.
 *
 * @param value - Mirror Node log
 * @param request - Request method and URL, for error messages
 * @returns The contract log
 */
function toContractLog(value: unknown, request: string): HederaContractLog {
  const log = isJsonObject(value) ? value : {};
  return {
    address: requireString(log.address, "logs.address", request).toLowerCase(),
    topics: requireArray(log.topics, "logs.topics", request).map(topic =>
      requireString(topic, "logs.topics", request).toLowerCase(),
    ),
    data: (nullableString(log.data, "logs.data", request) ?? "0x").toLowerCase(),
  };
}
