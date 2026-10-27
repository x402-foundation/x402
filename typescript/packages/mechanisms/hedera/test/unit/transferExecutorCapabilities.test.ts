import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountId,
  Client,
  ContractExecuteTransaction,
  PrecheckStatusError,
  PrivateKey,
  Status,
  TransactionId,
} from "@hiero-ledger/sdk";
import {
  createHederaGetTokenCustomFees,
  createHederaGetTransactionRecord,
  createHederaResolveEvmAddress,
  createHederaSimulateContractCall,
  createHederaSubmitContractExecute,
} from "../../src";

const BASE = "https://mirror.test";
const TESTNET = "hedera:testnet";

type MockReply = { status: number; body: unknown } | Error;

/**
 * Installs a fetch mock that answers each request through `handler`.
 * A plain object body is sent as JSON, a string body as raw text.
 *
 * @param handler - Maps the request URL and init to a reply
 * @returns The fetch mock
 */
function mockFetch(handler: (url: string, init?: RequestInit) => MockReply) {
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const reply = handler(String(input), init);
    if (reply instanceof Error) {
      throw reply;
    }
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createHederaResolveEvmAddress", () => {
  const resolve = createHederaResolveEvmAddress({ mirrorNodeUrl: BASE });

  it("returns the account's alias evm_address lowercased, with its account id", async () => {
    const fetchFn = mockFetch(() => ({
      status: 200,
      body: { account: "0.0.8065254", evm_address: "0x97D7F6B922E3A6634541623CE22B3BBD3E3C16E4" },
    }));

    await expect(resolve({ account: "0.0.8065254", network: TESTNET })).resolves.toEqual({
      accountId: "0.0.8065254",
      evmAddress: "0x97d7f6b922e3a6634541623ce22b3bbd3e3c16e4",
    });
    expect(fetchFn.mock.calls[0][0]).toBe(`${BASE}/api/v1/accounts/0.0.8065254`);
  });

  it("returns the long-zero evm_address of an account without an alias", async () => {
    mockFetch(() => ({
      status: 200,
      body: { account: "0.0.8065254", evm_address: "0x00000000000000000000000000000000007b10e6" },
    }));

    await expect(resolve({ account: "0.0.8065254", network: TESTNET })).resolves.toEqual({
      accountId: "0.0.8065254",
      evmAddress: "0x00000000000000000000000000000000007b10e6",
    });
  });

  it.each([
    ["does not know the account (HTTP 404)", 404, "0.0.404"],
    ["rejects the id (HTTP 400)", 400, "0.0.99999999999999999999"],
  ])("resolves undefined when the Mirror Node %s", async (_, status, account) => {
    mockFetch(() => ({ status, body: { _status: { messages: [{ message: "Not found" }] } } }));

    await expect(resolve({ account, network: TESTNET })).resolves.toBeUndefined();
  });

  it.each([
    ["absent", { account: "0.0.7001" }],
    ["null", { account: "0.0.7001", evm_address: null }],
  ])("resolves undefined when evm_address is %s", async (_, body) => {
    mockFetch(() => ({ status: 200, body }));

    await expect(resolve({ account: "0.0.7001", network: TESTNET })).resolves.toBeUndefined();
  });

  it.each([
    [
      "HTTP 429",
      { status: 429, body: { _status: { messages: [{ message: "Too many requests" }] } } },
    ],
    ["HTTP 503", { status: 503, body: { _status: { messages: [{ message: "Unavailable" }] } } }],
    ["a non-JSON 200 body", { status: 200, body: "<html>maintenance</html>" }],
    ["a network error", new TypeError("fetch failed")],
    ["a timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError")],
  ] as const)("throws on %s rather than reporting the account unresolved", async (_, reply) => {
    mockFetch(() => reply);

    await expect(resolve({ account: "0.0.7001", network: TESTNET })).rejects.toThrow(/Mirror Node/);
  });

  it("bounds every request with an abort signal", async () => {
    const fetchFn = mockFetch(() => ({ status: 404, body: {} }));

    await resolve({ account: "0.0.7001", network: TESTNET });

    expect(fetchFn.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("URL-encodes the account path segment", async () => {
    const fetchFn = mockFetch(() => ({ status: 404, body: {} }));

    await resolve({ account: "0.0.1/../tokens?x=1", network: TESTNET });

    expect(fetchFn.mock.calls[0][0]).toBe(`${BASE}/api/v1/accounts/0.0.1%2F..%2Ftokens%3Fx%3D1`);
  });

  it("throws when a 200 body carries no account id", async () => {
    mockFetch(() => ({
      status: 200,
      body: { evm_address: "0x97d7f6b922e3a6634541623ce22b3bbd3e3c16e4" },
    }));

    await expect(resolve({ account: "0.0.7001", network: TESTNET })).rejects.toThrow(/account/);
  });

  describe("mirror node URL", () => {
    it.each([
      ["a string, for every network", { mirrorNodeUrl: BASE }, "hedera:mainnet", BASE],
      [
        "a per-network record entry",
        { mirrorNodeUrl: { "hedera:mainnet": "https://main.example", [TESTNET]: BASE } },
        "hedera:mainnet",
        "https://main.example",
      ],
      [
        "the public testnet mirror when the record has no entry",
        { mirrorNodeUrl: { "hedera:mainnet": "https://main.example" } },
        TESTNET,
        "https://testnet.mirrornode.hedera.com",
      ],
      [
        "the public mainnet mirror by default",
        {},
        "hedera:mainnet",
        "https://mainnet-public.mirrornode.hedera.com",
      ],
      ["a string with its trailing slash removed", { mirrorNodeUrl: `${BASE}/` }, TESTNET, BASE],
    ])("uses %s", async (_, config, network, expectedBase) => {
      const fetchFn = mockFetch(() => ({ status: 404, body: {} }));

      await createHederaResolveEvmAddress(config)({ account: "0.0.7001", network });

      expect(fetchFn.mock.calls[0][0]).toBe(`${expectedBase}/api/v1/accounts/0.0.7001`);
    });

    it("rejects an unsupported network without a configured URL", async () => {
      mockFetch(() => ({ status: 404, body: {} }));

      await expect(
        createHederaResolveEvmAddress()({ account: "0.0.7001", network: "hedera:previewnet" }),
      ).rejects.toThrow(/Unsupported Hedera network/);
    });
  });
});

describe("createHederaGetTokenCustomFees", () => {
  const getFees = createHederaGetTokenCustomFees({ mirrorNodeUrl: BASE });

  it("counts zero fees for a fungible token with an empty schedule", async () => {
    const fetchFn = mockFetch(() => ({
      status: 200,
      body: {
        token_id: "0.0.429274",
        type: "FUNGIBLE_COMMON",
        custom_fees: { created_timestamp: "1.0", fixed_fees: [], fractional_fees: [] },
      },
    }));

    await expect(getFees({ tokenId: "0.0.429274", network: TESTNET })).resolves.toEqual({
      fixedFeeCount: 0,
      fractionalFeeCount: 0,
      royaltyFeeCount: 0,
    });
    expect(fetchFn.mock.calls[0][0]).toBe(`${BASE}/api/v1/tokens/0.0.429274`);
  });

  it("counts each kind of fee in the schedule", async () => {
    mockFetch(() => ({
      status: 200,
      body: {
        type: "FUNGIBLE_COMMON",
        custom_fees: {
          fixed_fees: [{ amount: 1 }, { amount: 2 }],
          fractional_fees: [{ amount: { numerator: 1, denominator: 100 } }],
          royalty_fees: [{}, {}, {}],
        },
      },
    }));

    await expect(getFees({ tokenId: "0.0.6001", network: TESTNET })).resolves.toEqual({
      fixedFeeCount: 2,
      fractionalFeeCount: 1,
      royaltyFeeCount: 3,
    });
  });

  it.each([
    ["HTTP 404", { status: 404, body: { _status: { messages: [{ message: "Not found" }] } } }],
    ["HTTP 400", { status: 400, body: { _status: { messages: [{ message: "Invalid id" }] } } }],
    [
      "a non-fungible token",
      { status: 200, body: { type: "NON_FUNGIBLE_UNIQUE", custom_fees: { fixed_fees: [] } } },
    ],
  ] as const)("resolves undefined for %s", async (_, reply) => {
    mockFetch(() => reply);

    await expect(getFees({ tokenId: "0.0.6001", network: TESTNET })).resolves.toBeUndefined();
  });

  it.each([
    ["HTTP 429", { status: 429, body: {} }],
    ["HTTP 500", { status: 500, body: {} }],
    ["a body without a token type", { status: 200, body: { custom_fees: {} } }],
    [
      "a body without custom_fees",
      { status: 200, body: { token_id: "0.0.6001", type: "FUNGIBLE_COMMON" } },
    ],
    [
      "a fee list that is not an array",
      { status: 200, body: { type: "FUNGIBLE_COMMON", custom_fees: { fixed_fees: {} } } },
    ],
    ["a network error", new TypeError("fetch failed")],
  ] as const)("throws on %s", async (_, reply) => {
    mockFetch(() => reply);

    await expect(getFees({ tokenId: "0.0.6001", network: TESTNET })).rejects.toThrow(/Mirror Node/);
  });
});

describe("createHederaSimulateContractCall", () => {
  const simulate = createHederaSimulateContractCall({ mirrorNodeUrl: BASE });
  const FROM = "0x97d7f6b922e3a6634541623ce22b3bbd3e3c16e4";
  const TO = "0x00000000000000000000000000000000009991e4";
  const DATA = "0xea8f19fd0000000000000000000000000000000000000000000000000000000000000001";

  function call(estimate = false) {
    return simulate({ network: TESTNET, from: FROM, to: TO, data: DATA, gas: 1_500_000, estimate });
  }

  it("POSTs the call to contracts/call at the latest block, without a value", async () => {
    const fetchFn = mockFetch(() => ({ status: 200, body: { result: "0x" } }));

    await call();

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/contracts/call`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toStrictEqual({
      block: "latest",
      data: DATA,
      estimate: false,
      from: FROM,
      gas: 1_500_000,
      to: TO,
    });
  });

  it("reports a 200 as not reverted", async () => {
    mockFetch(() => ({
      status: 200,
      body: { result: "0x0000000000000000000000000000000000000000000000000000000000000016" },
    }));

    await expect(call()).resolves.toStrictEqual({ reverted: false });
  });

  it("parses the hex result as the gas estimate when estimating", async () => {
    const fetchFn = mockFetch(() => ({ status: 200, body: { result: "0x0253f2" } }));

    await expect(call(true)).resolves.toStrictEqual({ reverted: false, gasEstimate: 152562 });
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body)).estimate).toBe(true);
  });

  it.each([["0x"], ["not-hex"], [42]])("throws when an estimate's result is %j", async result => {
    mockFetch(() => ({ status: 200, body: { result } }));

    await expect(call(true)).rejects.toThrow(/Mirror Node/);
  });

  function failure(message: string, detail = "", data = "0x") {
    return { status: 400, body: { _status: { messages: [{ message, detail, data }] } } };
  }

  it("reports CONTRACT_REVERT_EXECUTED as a revert, with the decoded detail and not the data", async () => {
    mockFetch(() => failure("CONTRACT_REVERT_EXECUTED", "authorization expired", "0x08c379a0"));

    await expect(call()).resolves.toStrictEqual({
      reverted: true,
      reason: "CONTRACT_REVERT_EXECUTED: authorization expired",
    });
  });

  it("reports a revert without detail by its status and revert data", async () => {
    mockFetch(() => failure("CONTRACT_REVERT_EXECUTED", "", "0x6f08ee6e"));

    await expect(call()).resolves.toStrictEqual({
      reverted: true,
      reason: "CONTRACT_REVERT_EXECUTED: revert data 0x6f08ee6e",
    });
  });

  it("caps revert data at 1,024 hex chars and marks it truncated", async () => {
    const kept = "ab".repeat(512);
    mockFetch(() => failure("CONTRACT_REVERT_EXECUTED", "", `0x${kept}cd`));

    await expect(call()).resolves.toStrictEqual({
      reverted: true,
      reason: `CONTRACT_REVERT_EXECUTED: revert data 0x${kept}... (truncated)`,
    });
  });

  it.each([
    ["absent", { message: "CONTRACT_REVERT_EXECUTED", detail: "" }],
    ["empty", { message: "CONTRACT_REVERT_EXECUTED", detail: "", data: "" }],
    ["0x", { message: "CONTRACT_REVERT_EXECUTED", detail: "", data: "0x" }],
  ])("reports a revert by its status alone when revert data is %s", async (_, entry) => {
    mockFetch(() => ({ status: 400, body: { _status: { messages: [entry] } } }));

    await expect(call()).resolves.toStrictEqual({
      reverted: true,
      reason: "CONTRACT_REVERT_EXECUTED",
    });
  });

  it("keeps revert data of exactly 1,024 hex chars whole", async () => {
    const whole = "ab".repeat(512);
    mockFetch(() => failure("CONTRACT_REVERT_EXECUTED", "", `0x${whole}`));

    await expect(call()).resolves.toStrictEqual({
      reverted: true,
      reason: `CONTRACT_REVERT_EXECUTED: revert data 0x${whole}`,
    });
  });

  it.each([
    ["SPENDER_DOES_NOT_HAVE_ALLOWANCE"],
    ["INSUFFICIENT_TOKEN_BALANCE"],
    ["INSUFFICIENT_GAS"],
  ])("reports execution status %s as a revert", async status => {
    mockFetch(() => failure(status));

    await expect(call()).resolves.toStrictEqual({ reverted: true, reason: status });
  });

  it.each([
    ["PAYER_ACCOUNT_NOT_FOUND for the facilitator's own from", failure("PAYER_ACCOUNT_NOT_FOUND")],
    ["a gas-cap validation message", failure("gas field must be less than or equal to 15000000")],
    ["a validation message", failure("Invalid parameter: from")],
    ["a 400 without messages", { status: 400, body: { _status: { messages: [] } } }],
    ["a non-JSON 400", { status: 400, body: "Bad Request" }],
    [
      "HTTP 429",
      { status: 429, body: { _status: { messages: [{ message: "Too many requests" }] } } },
    ],
    ["HTTP 500", { ...failure("FAIL_INVALID"), status: 500 }],
    [
      "HTTP 501",
      { status: 501, body: { _status: { messages: [{ message: "Precompile not supported" }] } } },
    ],
    ["HTTP 503", { status: 503, body: { _status: { messages: [{ message: "Timeout" }] } } }],
    ["a non-JSON 502", { status: 502, body: "error code: 502" }],
    ["a 200 without a JSON body", { status: 200, body: "" }],
    ["a network error", new TypeError("fetch failed")],
    ["a timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError")],
  ] as const)("throws on %s instead of reporting a revert", async (_, reply) => {
    mockFetch(() => reply);

    await expect(call()).rejects.toThrow(/Mirror Node/);
  });
});

describe("createHederaSubmitContractExecute", () => {
  const feePayerKey = PrivateKey.generateED25519();
  const FEE_PAYER = "0.0.5001";
  const TX_ID = "0.0.5001@1787055536.598669142";
  const CALLDATA = "0xea8f19fd00000000000000000000000000000000000000000000000000000000000000ff";
  const params = {
    network: TESTNET,
    feePayer: FEE_PAYER,
    contractId: "0.0.10064356",
    functionParameters: CALLDATA,
    gas: 1_500_000,
  };

  /**
   * Builds an offline testnet client whose `close` is observed.
   *
   * @returns The client and its `close` spy
   */
  function observedClient() {
    const client = Client.forTestnet();
    const close = vi.spyOn(client, "close");
    return { client, close };
  }

  /**
   * Replaces `ContractExecuteTransaction.execute` with a fake broadcast whose
   * receipt query resolves or rejects as given.
   *
   * @param receipt - The receipt the query resolves, or the error it rejects with
   * @returns The transactions that were "executed"
   */
  function fakeBroadcast(receipt: { status: Status } | Error) {
    const executed: ContractExecuteTransaction[] = [];
    vi.spyOn(ContractExecuteTransaction.prototype, "execute").mockImplementation(async function (
      this: ContractExecuteTransaction,
    ) {
      executed.push(this);
      const execute = vi.fn(() =>
        receipt instanceof Error ? Promise.reject(receipt) : Promise.resolve(receipt),
      );
      const setValidateStatus = vi.fn(() => ({ execute }));
      return {
        transactionId: { toString: () => TX_ID },
        getReceiptQuery: () => ({ setValidateStatus }),
      } as never;
    });
    return executed;
  }

  it("submits the contract call from the fee payer with the given gas and calldata, and no payable amount", async () => {
    const { client } = observedClient();
    const executed = fakeBroadcast({ status: Status.Success });

    await createHederaSubmitContractExecute(() => client, feePayerKey)(params);

    expect(executed).toHaveLength(1);
    const tx = executed[0];
    expect(tx.contractId?.toString()).toBe("0.0.10064356");
    expect(tx.gas?.toNumber()).toBe(1_500_000);
    expect(Buffer.from(tx.functionParameters ?? []).toString("hex")).toBe(CALLDATA.slice(2));
    expect(tx.transactionId?.accountId?.toString()).toBe(FEE_PAYER);
    expect(tx.payableAmount).toBeNull();
    expect(tx.isFrozen()).toBe(true);
    expect(feePayerKey.publicKey.verifyTransaction(tx)).toBe(true);
  });

  it("returns the transaction id and SUCCESS status", async () => {
    const { client, close } = observedClient();
    fakeBroadcast({ status: Status.Success });

    await expect(
      createHederaSubmitContractExecute(() => client, feePayerKey)(params),
    ).resolves.toStrictEqual({ transactionId: TX_ID, receiptStatus: "SUCCESS" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("returns a non-SUCCESS receipt status instead of throwing", async () => {
    const { client, close } = observedClient();
    fakeBroadcast({ status: Status.ContractRevertExecuted });

    await expect(
      createHederaSubmitContractExecute(() => client, feePayerKey)(params),
    ).resolves.toStrictEqual({ transactionId: TX_ID, receiptStatus: "CONTRACT_REVERT_EXECUTED" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("returns the transaction id without a status when the receipt query fails", async () => {
    const { client, close } = observedClient();
    fakeBroadcast(new Error("receipt query timed out"));

    await expect(
      createHederaSubmitContractExecute(() => client, feePayerKey)(params),
    ).resolves.toStrictEqual({ transactionId: TX_ID, receiptStatus: undefined });
    expect(close).toHaveBeenCalledTimes(1);
  });

  /**
   * Makes `ContractExecuteTransaction.execute` reject with an error.
   *
   * @param error - The error execute rejects with
   * @returns The transactions that were "executed"
   */
  function failedBroadcast(error: Error) {
    const executed: ContractExecuteTransaction[] = [];
    vi.spyOn(ContractExecuteTransaction.prototype, "execute").mockImplementation(async function (
      this: ContractExecuteTransaction,
    ) {
      executed.push(this);
      throw error;
    });
    return executed;
  }

  /**
   * Builds the error a node's precheck rejection raises.
   *
   * @param status - Precheck status
   * @returns The SDK precheck error
   */
  function precheckError(status: Status): PrecheckStatusError {
    return new PrecheckStatusError({
      status,
      transactionId: TransactionId.generate(AccountId.fromString(FEE_PAYER)),
      nodeId: AccountId.fromString("0.0.3"),
      contractFunctionResult: null,
    });
  }

  it("throws when a node rejects the transaction at precheck", async () => {
    const { client, close } = observedClient();
    failedBroadcast(precheckError(Status.InsufficientPayerBalance));

    await expect(
      createHederaSubmitContractExecute(() => client, feePayerKey)(params),
    ).rejects.toThrow(/INSUFFICIENT_PAYER_BALANCE/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a timeout", new Error("max attempts or timeout reached")],
    ["a duplicate-transaction precheck", precheckError(Status.DuplicateTransaction)],
  ])("returns the transaction id without a status when submission ends in %s", async (_, error) => {
    const { client, close } = observedClient();
    const executed = failedBroadcast(error);

    const result = await createHederaSubmitContractExecute(() => client, feePayerKey)(params);

    expect(result).toStrictEqual({
      transactionId: executed[0].transactionId!.toString(),
      receiptStatus: undefined,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([["ea8f19fd"], ["0xea8f19f"], ["0xzz"]])(
    "throws without broadcasting when the calldata is %j",
    async functionParameters => {
      const { client, close } = observedClient();
      const executed = fakeBroadcast({ status: Status.Success });

      await expect(
        createHederaSubmitContractExecute(
          () => client,
          feePayerKey,
        )({
          ...params,
          functionParameters,
        }),
      ).rejects.toThrow(/calldata/);
      expect(executed).toHaveLength(0);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );
});

describe("createHederaGetTransactionRecord", () => {
  it.each([
    ["timeoutMs", { timeoutMs: Number.NaN }],
    ["timeoutMs", { timeoutMs: 0 }],
    ["timeoutMs", { timeoutMs: Number.POSITIVE_INFINITY }],
    ["pollIntervalMs", { pollIntervalMs: -1 }],
    ["pollIntervalMs", { pollIntervalMs: Number.NaN }],
  ])("rejects a %s that is not a finite positive number: %j", (field, config) => {
    expect(() => createHederaGetTransactionRecord(config)).toThrow(field);
  });

  const TX_ID = "0.0.8065254@1787055536.598669142";
  const DASH_ID = "0.0.8065254-1787055536-598669142";
  const PARENT_TS = "1787055545.111111111";
  const TRANSACTIONS_URL = `${BASE}/api/v1/transactions/${DASH_ID}`;
  const RESULTS_URL = `${BASE}/api/v1/contracts/results/${DASH_ID}`;
  const EXECUTOR_LOG = {
    address: "0xF0D14FF4000000000000000000000000000E940A",
    contract_id: "0.0.10064356",
    data: "0x0000000000000000000000000000000000000000000000000000000005F5E100",
    index: 0,
    topics: ["0xDDF252AD1BE2C89B69C2B068FC378DAA952BA7F163C4A11628F55A4DF523B3EF"],
  };

  /**
   * Mirror transaction entry with empty transfer lists.
   *
   * @param overrides - Fields to set on the entry
   * @returns The entry
   */
  function entry(overrides: Record<string, unknown>) {
    return {
      charged_tx_fee: 0,
      consensus_timestamp: PARENT_TS,
      name: "CRYPTOTRANSFER",
      nft_transfers: [],
      nonce: 0,
      parent_consensus_timestamp: null,
      result: "SUCCESS",
      scheduled: false,
      staking_reward_transfers: [],
      token_transfers: [],
      transaction_id: DASH_ID,
      transfers: [],
      ...overrides,
    };
  }

  // The #3205 fixture: the parent CONTRACTCALL only pays the fee, the child
  // CRYPTOTRANSFER carries the payment.
  const fxParent = entry({
    name: "CONTRACTCALL",
    charged_tx_fee: 19682562,
    transfers: [
      { account: "0.0.802", amount: 19682562, is_approval: false },
      { account: "0.0.8065254", amount: -19682562, is_approval: false },
    ],
  });
  const fxChild = entry({
    consensus_timestamp: "1787055545.111111112",
    nonce: 1,
    parent_consensus_timestamp: PARENT_TS,
    transfers: [
      { account: "0.0.8065254", amount: -100000000, is_approval: true },
      { account: "0.0.10103069", amount: 100000000, is_approval: false },
    ],
  });

  function emptyEntry(result: string, chargedFee: string) {
    return {
      result,
      chargedFee,
      hbarTransfers: [],
      tokenTransfers: {},
      nftTransfers: [],
      stakingRewardTransfers: [],
    };
  }

  /**
   * Serves the record endpoints from the given bodies; anything else is a 404.
   *
   * @param transactions - Entries of the transactions endpoint
   * @param logs - Logs of the contract result
   * @returns The fetch mock
   */
  function serveRecord(transactions: unknown[], logs: unknown[] = [EXECUTOR_LOG]) {
    return mockFetch(url => {
      if (url === TRANSACTIONS_URL) {
        return { status: 200, body: { transactions, links: { next: null } } };
      }
      if (url === RESULTS_URL) {
        return { status: 200, body: { result: "SUCCESS", status: "0x1", logs } };
      }
      return { status: 404, body: { _status: { messages: [{ message: "Not found" }] } } };
    });
  }

  const getRecord = createHederaGetTransactionRecord({ mirrorNodeUrl: BASE });

  it("reads the payment from the child record and the fee from the parent", async () => {
    const fetchFn = serveRecord([fxParent, fxChild]);

    await expect(getRecord({ transactionId: TX_ID, network: TESTNET })).resolves.toStrictEqual({
      transactionId: TX_ID,
      status: "SUCCESS",
      transactionFee: "19682562",
      parent: {
        ...emptyEntry("SUCCESS", "19682562"),
        hbarTransfers: [
          { accountId: "0.0.802", amount: "19682562" },
          { accountId: "0.0.8065254", amount: "-19682562" },
        ],
      },
      children: [
        {
          ...emptyEntry("SUCCESS", "0"),
          hbarTransfers: [
            { accountId: "0.0.8065254", amount: "-100000000" },
            { accountId: "0.0.10103069", amount: "100000000" },
          ],
        },
      ],
      logs: [
        {
          address: "0xf0d14ff4000000000000000000000000000e940a",
          topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
          data: "0x0000000000000000000000000000000000000000000000000000000005f5e100",
        },
      ],
    });
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([TRANSACTIONS_URL, RESULTS_URL]),
    );
  });

  it("maps token, NFT and staking-reward movements per entry", async () => {
    serveRecord([
      entry({
        charged_tx_fee: 500,
        transfers: [
          { account: "0.0.800", amount: -42, is_approval: false },
          { account: "0.0.8065254", amount: 42, is_approval: false },
        ],
        staking_reward_transfers: [{ account: "0.0.8065254", amount: 42 }],
      }),
      entry({
        consensus_timestamp: "1787055545.111111112",
        nonce: 1,
        parent_consensus_timestamp: PARENT_TS,
        token_transfers: [
          { token_id: "0.0.429274", account: "0.0.8065254", amount: -1000, is_approval: true },
          { token_id: "0.0.429274", account: "0.0.10103069", amount: 1000, is_approval: false },
          { token_id: "0.0.6001", account: "0.0.10103069", amount: 7, is_approval: false },
        ],
        nft_transfers: [
          {
            token_id: "0.0.7001",
            serial_number: 3,
            sender_account_id: "0.0.8065254",
            receiver_account_id: "0.0.10103069",
            is_approval: false,
          },
          {
            token_id: "0.0.7001",
            serial_number: 4,
            sender_account_id: null,
            receiver_account_id: "0.0.10103069",
            is_approval: false,
          },
        ],
      }),
    ]);

    const record = await getRecord({ transactionId: TX_ID, network: TESTNET });

    expect(record?.parent).toStrictEqual({
      ...emptyEntry("SUCCESS", "500"),
      hbarTransfers: [
        { accountId: "0.0.800", amount: "-42" },
        { accountId: "0.0.8065254", amount: "42" },
      ],
      stakingRewardTransfers: [{ accountId: "0.0.8065254", amount: "42" }],
    });
    expect(record?.children).toStrictEqual([
      {
        ...emptyEntry("SUCCESS", "0"),
        tokenTransfers: {
          "0.0.429274": [
            { accountId: "0.0.8065254", amount: "-1000" },
            { accountId: "0.0.10103069", amount: "1000" },
          ],
          "0.0.6001": [{ accountId: "0.0.10103069", amount: "7" }],
        },
        nftTransfers: [
          {
            tokenId: "0.0.7001",
            serialNumber: "3",
            senderAccountId: "0.0.8065254",
            receiverAccountId: "0.0.10103069",
          },
          {
            tokenId: "0.0.7001",
            serialNumber: "4",
            senderAccountId: null,
            receiverAccountId: "0.0.10103069",
          },
        ],
      },
    ]);
  });

  it("keeps the logs of nested calls into other contracts", async () => {
    serveRecord(
      [fxParent],
      [
        { address: "0x00000000000000000000000000000000009991e4", topics: ["0x01"], data: "0x" },
        {
          address: "0x0000000000000000000000000000000000068cda",
          topics: ["0x02", "0x03"],
          data: "0x05",
        },
        { address: "0x00000000000000000000000000000000000b2ad5", topics: [], data: null },
      ],
    );

    const record = await getRecord({ transactionId: TX_ID, network: TESTNET });

    expect(record?.logs).toStrictEqual([
      { address: "0x00000000000000000000000000000000009991e4", topics: ["0x01"], data: "0x" },
      {
        address: "0x0000000000000000000000000000000000068cda",
        topics: ["0x02", "0x03"],
        data: "0x05",
      },
      { address: "0x00000000000000000000000000000000000b2ad5", topics: [], data: "0x" },
    ]);
  });

  it("leaves out entries that are scheduled or belong to another parent", async () => {
    serveRecord([
      entry({ scheduled: true, nonce: 0, consensus_timestamp: "1787055500.000000000" }),
      fxParent,
      fxChild,
      entry({ nonce: 1, parent_consensus_timestamp: "1787055500.000000000" }),
    ]);

    const record = await getRecord({ transactionId: TX_ID, network: TESTNET });

    expect(record?.transactionFee).toBe("19682562");
    expect(record?.children).toHaveLength(1);
    expect(record?.children[0].hbarTransfers[1]).toStrictEqual({
      accountId: "0.0.10103069",
      amount: "100000000",
    });
  });

  it("zero-pads the nanoseconds of the Mirror Node transaction id", async () => {
    const fetchFn = mockFetch(() => ({ status: 503, body: {} }));

    await expect(
      getRecord({ transactionId: "0.0.5001@1700000000.5", network: TESTNET }),
    ).rejects.toThrow(/Mirror Node/);
    expect(fetchFn.mock.calls[0][0]).toBe(
      `${BASE}/api/v1/transactions/0.0.5001-1700000000-000000005`,
    );
  });

  it("rejects a transaction id that is not in the SDK form", async () => {
    mockFetch(() => ({ status: 404, body: {} }));

    await expect(getRecord({ transactionId: DASH_ID, network: TESTNET })).rejects.toThrow(
      /transaction id/,
    );
  });

  describe("while the Mirror Node has not ingested the record", () => {
    const polling = createHederaGetTransactionRecord({
      mirrorNodeUrl: BASE,
      timeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });

    it("polls on 404 and resolves once the record appears", async () => {
      vi.useFakeTimers();
      let ingested = false;
      mockFetch(url => {
        if (!ingested) {
          return { status: 404, body: { _status: { messages: [{ message: "Not found" }] } } };
        }
        return url === TRANSACTIONS_URL
          ? { status: 200, body: { transactions: [fxParent, fxChild] } }
          : { status: 200, body: { logs: [] } };
      });

      const pending = polling({ transactionId: TX_ID, network: TESTNET });
      await vi.advanceTimersByTimeAsync(2_000);
      ingested = true;
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toMatchObject({ status: "SUCCESS", children: [{}] });
    });

    it("polls while only the contract result is missing", async () => {
      vi.useFakeTimers();
      let resultIngested = false;
      mockFetch(url => {
        if (url === TRANSACTIONS_URL) {
          return { status: 200, body: { transactions: [fxParent] } };
        }
        return resultIngested ? { status: 200, body: { logs: [] } } : { status: 404, body: {} };
      });

      const pending = polling({ transactionId: TX_ID, network: TESTNET });
      await vi.advanceTimersByTimeAsync(1_000);
      resultIngested = true;
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toMatchObject({ status: "SUCCESS", logs: [] });
    });

    it("resolves undefined once the deadline passes, and not before", async () => {
      vi.useFakeTimers();
      mockFetch(() => ({ status: 404, body: {} }));
      let settled = false;

      const pending = polling({ transactionId: TX_ID, network: TESTNET }).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toBeUndefined();
    });
  });

  it.each([
    ["HTTP 503 on the transactions endpoint", TRANSACTIONS_URL, { status: 503, body: {} }],
    ["HTTP 429 on the transactions endpoint", TRANSACTIONS_URL, { status: 429, body: {} }],
    ["HTTP 500 on the contract result", RESULTS_URL, { status: 500, body: {} }],
    ["a network error", TRANSACTIONS_URL, new TypeError("fetch failed")],
    ["a non-JSON body", TRANSACTIONS_URL, { status: 200, body: "<html>" }],
  ] as const)("throws on %s", async (_, failingUrl, reply) => {
    mockFetch(url => {
      if (url === failingUrl) {
        return reply;
      }
      return url === TRANSACTIONS_URL
        ? { status: 200, body: { transactions: [fxParent] } }
        : { status: 200, body: { logs: [] } };
    });

    await expect(getRecord({ transactionId: TX_ID, network: TESTNET })).rejects.toThrow(
      /Mirror Node/,
    );
  });

  it.each([
    ["an HBAR amount", { transfers: [{ account: "0.0.1", amount: 2 ** 53 }] }],
    ["a charged fee", { charged_tx_fee: 1e20 }],
    [
      "a token amount",
      { token_transfers: [{ token_id: "0.0.6001", account: "0.0.1", amount: -(2 ** 60) }] },
    ],
    ["a fractional amount", { transfers: [{ account: "0.0.1", amount: 1.5 }] }],
    ["a string amount", { transfers: [{ account: "0.0.1", amount: "100" }] }],
  ])("throws rather than return %s that lost precision or is not an integer", async (_, fields) => {
    serveRecord([{ ...fxParent, ...fields }]);

    await expect(getRecord({ transactionId: TX_ID, network: TESTNET })).rejects.toThrow(
      /safe integer/,
    );
  });

  it("throws when the body has no parent transaction", async () => {
    serveRecord([fxChild]);

    await expect(getRecord({ transactionId: TX_ID, network: TESTNET })).rejects.toThrow(
      /no parent transaction/,
    );
  });

  it.each([
    ["transfers", { transfers: null }],
    ["token_transfers", { token_transfers: undefined }],
    ["nft_transfers", { nft_transfers: {} }],
    ["staking_reward_transfers", { staking_reward_transfers: null }],
  ])("throws when %s is not a list", async (field, fields) => {
    serveRecord([{ ...fxParent, ...fields }]);

    await expect(getRecord({ transactionId: TX_ID, network: TESTNET })).rejects.toThrow(
      new RegExp(`non-array ${field}`),
    );
  });

  it("throws when the contract result has no logs list", async () => {
    mockFetch(url =>
      url === TRANSACTIONS_URL
        ? { status: 200, body: { transactions: [fxParent] } }
        : { status: 200, body: { result: "SUCCESS" } },
    );

    await expect(getRecord({ transactionId: TX_ID, network: TESTNET })).rejects.toThrow(
      /non-array logs/,
    );
  });
});
