import { Address, beginCell, Cell, loadMessage, type StateInit } from "@ton/core";
import {
  DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
  DEFAULT_TONCENTER_TIMEOUT_SECONDS,
  JETTON_TRANSFER_OPCODE,
  SUPPORTED_TVM_PROVIDERS,
  TONAPI_MAINNET_BASE_URL,
  TONAPI_TESTNET_BASE_URL,
  TONCENTER_MAINNET_BASE_URL,
  TONCENTER_TESTNET_BASE_URL,
  TVM_MAINNET,
  TVM_PROVIDER_TONAPI,
  TVM_PROVIDER_TONCENTER,
  TVM_TESTNET,
  W5_EXTERNAL_SIGNED_OPCODE,
  W5_INTERNAL_SIGNED_OPCODE,
} from "./constants";
import type { TvmAccountState, TvmJettonWalletData } from "./types";
import { addressToStackItem, normalizeAddress } from "./codecs/common";

export type TvmProviderName = typeof TVM_PROVIDER_TONCENTER | typeof TVM_PROVIDER_TONAPI;

export interface TvmProviderClient {
  getAccountState(address: string): Promise<TvmAccountState>;
  close(): void;
  getJettonWallet(asset: string, owner: string): Promise<string>;
  getJettonWalletData(address: string): Promise<TvmJettonWalletData>;
  sendMessage(boc: Buffer): Promise<string>;
  emulateTrace(
    boc: Buffer,
    options?: { ignoreChksig?: boolean; timeout?: number },
  ): Promise<Record<string, unknown>>;
  getTraceByMessageHash(messageHash: string): Promise<Record<string, unknown>>;
  runGetMethod(
    address: string,
    method: string,
    stack: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]>;
}

export function createTvmProviderClient(
  network: string,
  {
    provider = TVM_PROVIDER_TONCENTER,
    apiKey,
    baseUrl,
    timeout = DEFAULT_TONCENTER_TIMEOUT_SECONDS,
  }: {
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
    timeout?: number;
  } = {},
): TvmProviderClient {
  const normalizedProvider = provider.trim().toLowerCase();
  if (!SUPPORTED_TVM_PROVIDERS.has(normalizedProvider)) {
    throw new Error(`Unsupported TVM provider: ${normalizedProvider}`);
  }
  if (normalizedProvider === TVM_PROVIDER_TONAPI) {
    return new TonapiRestClient(network, { apiKey, baseUrl, timeout });
  }
  return new ToncenterRestClient(network, { apiKey, baseUrl, timeout });
}

export class ToncenterRestClient implements TvmProviderClient {
  private readonly rootUrl: string;
  private readonly headers: Record<string, string>;

  constructor(
    network: string,
    {
      apiKey,
      baseUrl,
      timeout = DEFAULT_TONCENTER_TIMEOUT_SECONDS,
    }: { apiKey?: string; baseUrl?: string; timeout?: number } = {},
  ) {
    this.rootUrl = (baseUrl ?? defaultBaseUrl(network)).replace(/\/$/, "");
    this.headers = { Accept: "application/json" };
    if (apiKey) {
      this.headers["X-Api-Key"] = apiKey;
    }
    this.timeout = timeout;
  }

  private readonly timeout: number;

  close(): void {}

  async getAccountState(address: string): Promise<TvmAccountState> {
    const normalizedAddress = normalizeAddress(address);
    const response = await this.request("GET", "/api/v3/accountStates", {
      params: { address: [normalizedAddress], include_boc: "true" },
    });
    const accounts = Array.isArray(response.accounts) ? response.accounts : [];
    if (!accounts.length) {
      return syntheticUninitializedAccount(normalizedAddress);
    }
    return accountStateFromPayload(normalizedAddress, asRecord(accounts[0]), {
      codeKey: "code_boc",
      dataKey: "data_boc",
    });
  }

  async getJettonWallet(asset: string, owner: string): Promise<string> {
    const result = await this.runGetMethod(asset, "get_wallet_address", [
      addressToStackItem(owner),
    ]);
    return parseStackAddress(result[0]);
  }

  async getJettonWalletData(address: string): Promise<TvmJettonWalletData> {
    const result = await this.runGetMethod(address, "get_wallet_data", []);
    if (result.length < 3) {
      throw new Error("Toncenter get_wallet_data returned an incomplete stack");
    }
    return {
      address: normalizeAddress(address),
      balance: parseStackNum(result[0]),
      owner: parseStackAddress(result[1]),
      jettonMinter: parseStackAddress(result[2]),
    };
  }

  async sendMessage(boc: Buffer): Promise<string> {
    const response = await this.request("POST", "/api/v3/message", {
      json: { boc: boc.toString("base64") },
    });
    return String(response.message_hash_norm ?? response.message_hash ?? "");
  }

  async emulateTrace(
    boc: Buffer,
    options: { ignoreChksig?: boolean; timeout?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/emulate/v1/emulateTrace", {
      json: {
        boc: boc.toString("base64"),
        ignore_chksig: options.ignoreChksig ?? false,
        with_actions: true,
      },
      timeout: options.timeout ?? DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
    });
  }

  async getTraceByMessageHash(messageHash: string): Promise<Record<string, unknown>> {
    const response = await this.request("GET", "/api/v3/traces", {
      params: { msg_hash: [messageHash], limit: 1, sort: "desc" },
    });
    const traces = response.traces;
    if (!Array.isArray(traces)) {
      throw new Error("Toncenter returned an invalid traces response");
    }
    for (const trace of traces) {
      if (trace && typeof trace === "object") {
        return trace as Record<string, unknown>;
      }
    }
    throw new Error(`Toncenter returned no trace for message hash ${messageHash}`);
  }

  async runGetMethod(
    address: string,
    method: string,
    stack: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const response = await this.request("POST", "/api/v3/runGetMethod", {
      json: {
        address: normalizeAddress(address),
        method,
        stack,
      },
    });
    if (Number(response.exit_code ?? 0) !== 0) {
      throw new Error(`Toncenter get-method ${method} failed with exit code ${response.exit_code}`);
    }
    if (!Array.isArray(response.stack)) {
      throw new Error(`Toncenter returned an invalid stack for get-method ${method}`);
    }
    return response.stack.filter(item => item && typeof item === "object") as Record<
      string,
      unknown
    >[];
  }

  private request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return requestJson(this.rootUrl, this.headers, "Toncenter", method, path, {
      timeout: this.timeout,
      ...options,
    });
  }
}

export class TonapiRestClient implements TvmProviderClient {
  private readonly rootUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;

  constructor(
    network: string,
    {
      apiKey,
      baseUrl,
      timeout = DEFAULT_TONCENTER_TIMEOUT_SECONDS,
    }: { apiKey?: string; baseUrl?: string; timeout?: number } = {},
  ) {
    this.rootUrl = (baseUrl ?? defaultBaseUrl(network, TVM_PROVIDER_TONAPI)).replace(/\/$/, "");
    this.headers = { Accept: "application/json" };
    if (apiKey) {
      this.headers.Authorization = `Bearer ${apiKey}`;
    }
    this.timeout = timeout;
  }

  close(): void {}

  async getAccountState(address: string): Promise<TvmAccountState> {
    const normalizedAddress = normalizeAddress(address);
    try {
      const account = await this.request("GET", `/v2/blockchain/accounts/${normalizedAddress}`);
      return accountStateFromPayload(normalizedAddress, account, {
        codeKey: "code",
        dataKey: "data",
      });
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 404) {
        return syntheticUninitializedAccount(normalizedAddress);
      }
      throw error;
    }
  }

  async getJettonWallet(asset: string, owner: string): Promise<string> {
    const result = await this.runGetMethod(asset, "get_wallet_address", [
      addressToStackItem(owner),
    ]);
    return parseStackAddress(result[0]);
  }

  async getJettonWalletData(address: string): Promise<TvmJettonWalletData> {
    const result = await this.runGetMethod(address, "get_wallet_data", []);
    if (result.length < 3) {
      throw new Error("TonAPI get_wallet_data returned an incomplete stack");
    }
    return {
      address: normalizeAddress(address),
      balance: parseStackNum(result[0]),
      owner: parseStackAddress(result[1]),
      jettonMinter: parseStackAddress(result[2]),
    };
  }

  async sendMessage(boc: Buffer): Promise<string> {
    await this.request("POST", "/v2/blockchain/message", {
      json: { boc: boc.toString("base64") },
      allowEmptyResponse: true,
    });
    return normalizedExternalMessageHashHex(boc);
  }

  async emulateTrace(
    boc: Buffer,
    options: { ignoreChksig?: boolean; timeout?: number } = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.request("POST", "/v2/traces/emulate", {
      params: { ignore_signature_check: options.ignoreChksig ?? false },
      json: { boc: boc.toString("base64") },
      timeout: options.timeout ?? DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
    });
    return tonapiTraceToToncenter(response);
  }

  async getTraceByMessageHash(messageHash: string): Promise<Record<string, unknown>> {
    const traceId = encodeURIComponent(messageHash);
    return tonapiTraceToToncenter(await this.request("GET", `/v2/traces/${traceId}`));
  }

  async runGetMethod(
    address: string,
    method: string,
    stack: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const response = await this.request(
      "POST",
      `/v2/blockchain/accounts/${normalizeAddress(address)}/methods/${encodeURIComponent(method)}`,
      { json: { args: stack.map(tonapiGetMethodArg) } },
    );
    if (response.success === false || Number(response.exit_code ?? 0) !== 0) {
      throw new Error(`TonAPI get-method ${method} failed with exit code ${response.exit_code}`);
    }
    if (!Array.isArray(response.stack)) {
      throw new Error(`TonAPI returned an invalid stack for get-method ${method}`);
    }
    return response.stack
      .filter(item => item && typeof item === "object")
      .map(item => tonapiStackRecordToToncenter(item as Record<string, unknown>));
  }

  private request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return requestJson(this.rootUrl, this.headers, "TonAPI", method, path, {
      timeout: this.timeout,
      ...options,
    });
  }
}

export function defaultBaseUrl(network: string, provider = TVM_PROVIDER_TONCENTER): string {
  const normalizedProvider = provider.trim().toLowerCase();
  if (normalizedProvider === TVM_PROVIDER_TONCENTER) {
    if (network === TVM_MAINNET) return TONCENTER_MAINNET_BASE_URL;
    if (network === TVM_TESTNET) return TONCENTER_TESTNET_BASE_URL;
  }
  if (normalizedProvider === TVM_PROVIDER_TONAPI) {
    if (network === TVM_MAINNET) return TONAPI_MAINNET_BASE_URL;
    if (network === TVM_TESTNET) return TONAPI_TESTNET_BASE_URL;
  }
  throw new Error(`Unsupported TVM provider/network: ${provider}/${network}`);
}

type RequestOptions = {
  params?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  json?: unknown;
  timeout?: number;
  allowEmptyResponse?: boolean;
};

class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function requestJson(
  rootUrl: string,
  headers: Record<string, string>,
  providerLabel: string,
  method: string,
  path: string,
  options: RequestOptions,
): Promise<Record<string, unknown>> {
  const attempts = 5;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const url = new URL(path, `${rootUrl}/`);
      for (const [key, value] of Object.entries(options.params ?? {})) {
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) {
          url.searchParams.append(key, String(item));
        }
      }
      const response = await fetch(url, {
        method,
        headers: {
          ...headers,
          ...(options.json === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.json === undefined ? undefined : JSON.stringify(options.json),
        signal: AbortSignal.timeout(Math.max(1, (options.timeout ?? 2) * 1000)),
      });
      if (!response.ok) {
        const retryable = [429, 500, 502, 503, 504].includes(response.status);
        if (!retryable || attempt === attempts - 1) {
          throw new HttpStatusError(
            response.status,
            `${providerLabel} ${path}: ${response.status}`,
          );
        }
        const retryAfter = response.headers.get("Retry-After");
        await delay(retryAfter ? Number(retryAfter) * 1000 : 250 * (attempt + 1));
        continue;
      }
      const text = await response.text();
      if (!text && options.allowEmptyResponse) {
        return {};
      }
      const data = JSON.parse(text) as unknown;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error(`${providerLabel} returned a non-object response for ${path}`);
      }
      return data as Record<string, unknown>;
    } catch (error) {
      lastError = error;
      if (error instanceof HttpStatusError) throw error;
      if (attempt === attempts - 1) throw error;
      await delay(250 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${providerLabel} request failed`);
}

function accountStateFromPayload(
  address: string,
  account: Record<string, unknown>,
  { codeKey, dataKey }: { codeKey: string; dataKey: string },
): TvmAccountState {
  const status = String(account.status ?? "");
  let stateInit: StateInit | null = null;
  const codeBoc = account[codeKey];
  const dataBoc = account[dataKey];
  if (status === "active" && typeof codeBoc === "string" && typeof dataBoc === "string") {
    stateInit = {
      code: Cell.fromBoc(decodeBocText(codeBoc))[0],
      data: Cell.fromBoc(decodeBocText(dataBoc))[0],
    };
  }
  return {
    address,
    balance: BigInt(String(account.balance ?? "0")),
    isActive: status === "active",
    isUninitialized: status === "uninit" || status === "nonexist",
    isFrozen: status === "frozen",
    stateInit,
  };
}

function syntheticUninitializedAccount(address: string): TvmAccountState {
  return {
    address,
    balance: 0n,
    isActive: false,
    isUninitialized: true,
    isFrozen: false,
    stateInit: null,
  };
}

function parseStackAddress(item: Record<string, unknown>): string {
  const address = parseStackCell(item).beginParse().loadAddress();
  if (!address) {
    throw new Error("Can't parse address stack value");
  }
  return normalizeAddress(address);
}

function parseStackCell(item: Record<string, unknown>): Cell {
  const value = item.value;
  if (!value) {
    throw new Error("Can't parse cell stack value");
  }
  return Cell.fromBoc(Buffer.from(String(value), "base64"))[0];
}

function parseStackNum(item: Record<string, unknown>): bigint {
  return BigInt(String(item.value ?? "0"));
}

function tonapiGetMethodArg(item: Record<string, unknown>): Record<string, string> {
  const itemType = String(item.type ?? "");
  const value = item.value;
  if (value === undefined || value === null) {
    throw new Error(`TonAPI get-method stack item is missing value: ${JSON.stringify(item)}`);
  }
  if (itemType === "slice") {
    if (typeof value === "string") {
      try {
        const cell = Cell.fromBoc(Buffer.from(value, "base64"))[0];
        const address = cell.beginParse().loadAddress();
        if (address) {
          return { type: "slice", value: normalizeAddress(address) };
        }
      } catch {
        // Fall through and treat the value as a raw slice BoC.
      }
      return { type: "slice_boc_hex", value: decodeBocText(value).toString("hex") };
    }
  }
  if (itemType === "cell") {
    return { type: "cell_boc_base64", value: String(value) };
  }
  if (["num", "int"].includes(itemType)) {
    return { type: "int257", value: String(value) };
  }
  if (["nan", "null", "tinyint", "int257", "cell_boc_base64", "slice_boc_hex"].includes(itemType)) {
    return { type: itemType, value: String(value) };
  }
  throw new Error(`Unsupported TonAPI get-method stack item type: ${itemType}`);
}

function tonapiStackRecordToToncenter(record: Record<string, unknown>): Record<string, unknown> {
  const recordType = String(record.type ?? "");
  if (recordType === "num") {
    return { type: "num", value: String(record.num ?? "0") };
  }
  if (recordType === "cell" && record.cell !== undefined) {
    return { type: "cell", value: cellBocToBase64(record.cell) };
  }
  if (recordType === "tuple" && Array.isArray(record.tuple)) {
    return {
      type: "tuple",
      value: record.tuple
        .filter(item => item && typeof item === "object")
        .map(item => tonapiStackRecordToToncenter(item as Record<string, unknown>)),
    };
  }
  if (recordType === "null") {
    return { type: "null", value: null };
  }
  if (recordType === "nan") {
    return { type: "nan", value: "NaN" };
  }
  if (recordType === "slice" && record.slice !== undefined) {
    const value = record.slice;
    if (typeof value === "string") {
      try {
        const cell = beginCell().storeAddress(Address.parse(value)).endCell();
        return { type: "slice", value: cell.toBoc().toString("base64") };
      } catch {
        // Fall through and normalize it as a BoC-like value.
      }
    }
    return { type: "slice", value: cellBocToBase64(value) };
  }
  throw new Error(`TonAPI returned an unsupported stack record: ${JSON.stringify(record)}`);
}

function tonapiTraceToToncenter(trace: Record<string, unknown>): Record<string, unknown> {
  const transactions: Record<string, Record<string, unknown>> = {};

  function walk(node: Record<string, unknown>): Record<string, unknown> | null {
    const transaction = asRecordOrNull(node.transaction);
    let converted: Record<string, unknown> | null = null;
    if (transaction) {
      converted = tonapiTransactionToToncenter(transaction);
      const transactionHash = String(converted.hash || Object.keys(transactions).length);
      transactions[transactionHash] = converted;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      if (child && typeof child === "object") {
        const childTransaction = walk(child as Record<string, unknown>);
        if (converted && childTransaction) {
          appendChildInMsgAsParentOutMsg(converted, childTransaction);
        }
      }
    }
    return converted;
  }

  walk(trace);
  return { transactions, is_incomplete: false };
}

function appendChildInMsgAsParentOutMsg(
  parentTransaction: Record<string, unknown>,
  childTransaction: Record<string, unknown>,
): void {
  const childInMsg = asRecordOrNull(childTransaction.in_msg);
  if (!childInMsg) return;
  const outMsgs = Array.isArray(parentTransaction.out_msgs)
    ? (parentTransaction.out_msgs as Record<string, unknown>[])
    : [];
  const childHash = childInMsg.hash;
  if (childHash && outMsgs.some(message => asRecord(message).hash === childHash)) {
    return;
  }
  outMsgs.push({ ...childInMsg });
  parentTransaction.out_msgs = outMsgs;
}

function tonapiTransactionToToncenter(
  transaction: Record<string, unknown>,
): Record<string, unknown> {
  return {
    account: tonapiAccountAddress(transaction.account),
    hash: String(transaction.hash ?? ""),
    hash_norm: String(transaction.hash ?? ""),
    description: {
      aborted: transaction.aborted,
      compute_ph: tonapiComputePhase(transaction.compute_phase),
      action: tonapiActionPhase(transaction.action_phase),
      storage_ph: tonapiStoragePhase(transaction.storage_phase),
    },
    in_msg: tonapiMessageToToncenter(transaction.in_msg),
    out_msgs: Array.isArray(transaction.out_msgs)
      ? transaction.out_msgs
          .filter(message => message && typeof message === "object")
          .map(message => tonapiMessageToToncenter(message))
      : [],
  };
}

function tonapiComputePhase(phase: unknown): Record<string, unknown> {
  const record = asRecordOrNull(phase);
  if (!record) {
    return { skipped: true, success: false };
  }
  return {
    skipped: record.skipped,
    success: record.success,
    gas_fees: record.gas_fees,
  };
}

function tonapiActionPhase(phase: unknown): Record<string, unknown> | null {
  const record = asRecordOrNull(phase);
  if (!record) return null;
  return {
    success: record.success,
    total_fwd_fees: record.fwd_fees,
    fwd_fee: record.fwd_fees,
    total_fees: record.total_fees,
  };
}

function tonapiStoragePhase(phase: unknown): Record<string, unknown> {
  const record = asRecordOrNull(phase);
  if (!record) return {};
  return {
    storage_fees_collected: record.fees_collected,
    storage_fees_due: record.fees_due,
  };
}

function tonapiMessageToToncenter(message: unknown): Record<string, unknown> {
  const record = asRecordOrNull(message);
  if (!record) return {};
  const converted: Record<string, unknown> = {
    hash: String(record.hash ?? ""),
    hash_norm: String(record.hash ?? ""),
    source: tonapiAccountAddress(record.source),
    destination: tonapiAccountAddress(record.destination),
    decoded_opcode: normalizeDecodedOpcode(record),
    fwd_fee: record.fwd_fee,
    value: record.value,
  };
  const messageContent: Record<string, unknown> = {};
  if (typeof record.raw_body === "string" && record.raw_body) {
    try {
      messageContent.hash = Cell.fromBoc(decodeBocText(record.raw_body))[0]
        .hash()
        .toString("base64");
    } catch {
      // Some TonAPI trace bodies are decoded-only; hash validation is best-effort here.
    }
  }
  if (record.decoded_body !== undefined) {
    messageContent.decoded = record.decoded_body;
  }
  if (Object.keys(messageContent).length) {
    converted.message_content = messageContent;
  }
  return converted;
}

function tonapiAccountAddress(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const address = (value as Record<string, unknown>).address;
    return typeof address === "string" && address ? normalizeAddress(address) : "";
  }
  return typeof value === "string" && value ? normalizeAddress(value) : "";
}

function normalizeDecodedOpcode(message: Record<string, unknown>): string {
  const opcodeName = message.decoded_op_name;
  if (typeof opcodeName === "string" && opcodeName) {
    return opcodeName
      .replace(/(?<!^)(?=[A-Z])/g, "_")
      .toLowerCase()
      .replace("__", "_");
  }
  const opcode = message.op_code;
  let opcodeInt: number | null = null;
  if (typeof opcode === "number") {
    opcodeInt = opcode;
  } else if (typeof opcode === "string") {
    const parsed = Number.parseInt(opcode, 0);
    opcodeInt = Number.isNaN(parsed) ? null : parsed;
  }
  if (opcodeInt !== null) {
    return (
      {
        [JETTON_TRANSFER_OPCODE]: "jetton_transfer",
        [0x178d4519]: "jetton_internal_transfer",
        [W5_INTERNAL_SIGNED_OPCODE]: "w5_internal_signed_request",
        [W5_EXTERNAL_SIGNED_OPCODE]: "w5_external_signed_request",
      }[opcodeInt] ?? `0x${opcodeInt.toString(16)}`
    );
  }
  return "";
}

function cellBocToBase64(value: unknown): string {
  return decodeBocText(String(value)).toString("base64");
}

function decodeBocText(value: string): Buffer {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("BOC value is empty");
  }
  if (normalized.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(normalized)) {
    return Buffer.from(normalized, "hex");
  }
  return Buffer.from(normalized, "base64");
}

function normalizedExternalMessageHashHex(boc: Buffer): string {
  const message = loadMessage(Cell.fromBoc(boc)[0].beginParse());
  if (message.info.type !== "external-in") {
    return message.body.hash().toString("hex");
  }
  return beginCell()
    .storeUint(2, 2)
    .storeAddress(null)
    .storeAddress(message.info.dest)
    .storeCoins(0)
    .storeBit(false)
    .storeBit(true)
    .storeRef(message.body)
    .endCell()
    .hash()
    .toString("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return Object.keys(record).length ? record : null;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Number.isFinite(ms) ? ms : 250));
}
