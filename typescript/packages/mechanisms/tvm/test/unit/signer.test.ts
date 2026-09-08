import { afterEach, describe, expect, it, vi } from "vitest";
import { Address, beginCell, Cell, Dictionary, external, storeMessage } from "@ton/core";
import { keyPairFromSeed } from "@ton/crypto";
import {
  loadHighloadQueryState,
  MAX_USABLE_QUERY_SEQNO,
  queryIdIsProcessed,
  seqnoToQueryId,
  serializeInternalTransfer,
} from "../../src/codecs/highload-v3";
import {
  DEFAULT_HIGHLOAD_SUBWALLET_ID,
  DEFAULT_HIGHLOAD_TIMEOUT,
  DEFAULT_SETTLEMENT_BATCH_MAX_SIZE,
  HIGHLOAD_V3_CODE_HEX,
  TVM_MAINNET,
  TVM_PROVIDER_TONAPI,
  TVM_TESTNET,
} from "../../src/constants";
import {
  createTvmProviderClient,
  defaultBaseUrl,
  TonapiRestClient,
  ToncenterRestClient,
} from "../../src/provider";
import {
  HighloadV3Config,
  toClientTvmSigner,
  toFacilitatorTvmSigner,
  type ClientTvmSigner,
} from "../../src/signer";
import type { TvmAccountState, TvmRelayRequest } from "../../src/types";
import * as tvmPackage from "../../src/index";
import { ExactTvmScheme as ExactClientScheme } from "../../src/exact/client";
import { ExactTvmScheme as ExactFacilitatorScheme } from "../../src/exact/facilitator";
import { ExactTvmScheme as ExactServerScheme } from "../../src/exact/server";
import { ExactTvmScheme as ExactScheme } from "../../src/exact";
import {
  isTvmTestnet,
  isValidTvmNetwork,
  makeZeroBitCellBoc,
  normalizeTonAddress,
  parseDecimalAmount,
  priceToNano,
} from "../../src/utils";

const TEST_ADDRESS = "0:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const OWNER_ADDRESS = "0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ASSET_ADDRESS = "0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function addressStackItem(address: string): { type: "slice"; value: string } {
  const cell = beginCell().storeAddress(Address.parse(address)).endCell();
  return { type: "slice", value: cell.toBoc().toString("base64") };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function activeAccountPayload(codeBoc: string, dataBoc: string) {
  return {
    status: "active",
    balance: "1000000",
    code_boc: codeBoc,
    data_boc: dataBoc,
  };
}

function bitmapWithBit(bitNumber: number): Cell {
  const builder = beginCell();
  for (let index = 0; index < bitNumber; index += 1) {
    builder.storeBit(false);
  }
  builder.storeBit(true);
  return builder.endCell();
}

function buildHighloadAccountState(
  options: {
    lastCleanTime?: number;
    timeout?: number;
    processedQueryId?: number;
    isActive?: boolean;
  } = {},
): TvmAccountState {
  const code = Cell.fromBoc(Buffer.from(HIGHLOAD_V3_CODE_HEX, "hex"))[0];
  const publicKey = Buffer.alloc(32, 9);
  const lastCleanTime = options.lastCleanTime ?? Math.floor(Date.now() / 1000);
  const timeout = options.timeout ?? DEFAULT_HIGHLOAD_TIMEOUT;

  let oldQueriesDict = Dictionary.empty<number, Cell>(
    Dictionary.Keys.Uint(13),
    Dictionary.Values.Cell(),
  );
  let queriesDict = Dictionary.empty<number, Cell>(
    Dictionary.Keys.Uint(13),
    Dictionary.Values.Cell(),
  );

  if (options.processedQueryId !== undefined) {
    const shift = options.processedQueryId >> 10;
    const bitNumber = options.processedQueryId & 1023;
    queriesDict.set(shift, bitmapWithBit(bitNumber));
  }

  const data = beginCell()
    .storeBuffer(publicKey, 32)
    .storeUint(DEFAULT_HIGHLOAD_SUBWALLET_ID, 32)
    .storeDict(oldQueriesDict)
    .storeDict(queriesDict)
    .storeUint(lastCleanTime, 64)
    .storeUint(timeout, 22)
    .endCell();

  return {
    address: TEST_ADDRESS,
    balance: 2_000_000_000n,
    isActive: options.isActive ?? true,
    isUninitialized: false,
    isFrozen: false,
    stateInit: { code, data },
  };
}

function installFetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      return handler(url, init);
    }),
  );
}

describe("TVM signers", () => {
  it("creates a W5R1 client signer with network-bound wallet id and state init", () => {
    const signer = toClientTvmSigner(keyPairFromSeed(Buffer.alloc(32, 1)), {
      network: TVM_TESTNET,
    });

    expect(signer.address).toMatch(/^0:[0-9a-f]{64}$/);
    expect(signer.network).toBe(TVM_TESTNET);
    expect(signer.walletId).toBeTypeOf("number");
    expect(signer.stateInit.code?.hash().toString("hex")).toBe(
      "20834b7b72b112147e1b2fb457b84e74d1a30f04f737d4f62a668e9552d2b72f",
    );
  });

  it("supports legacy boolean network selection", () => {
    const mainnetSigner = toClientTvmSigner(keyPairFromSeed(Buffer.alloc(32, 4)), false);
    const testnetSigner = toClientTvmSigner(keyPairFromSeed(Buffer.alloc(32, 5)), true);
    expect(mainnetSigner.network).toBe(TVM_MAINNET);
    expect(testnetSigner.network).toBe(TVM_TESTNET);
  });

  it("signs a transfer into a base64 settlement BoC", async () => {
    const signer = toClientTvmSigner(keyPairFromSeed(Buffer.alloc(32, 2)), {
      network: TVM_TESTNET,
    });

    const boc = await signer.signTransfer(
      0,
      Math.floor(Date.now() / 1000) + 60,
      [
        {
          address: "0:3333333333333333333333333333333333333333333333333333333333333333",
          amount: 1n,
          body: beginCell().storeUint(0, 1).endCell(),
        },
      ],
      { includeStateInit: true },
    );

    expect(Buffer.from(boc, "base64").length).toBeGreaterThan(0);
  });

  it("normalizes 32-byte facilitator private keys to secret keys", () => {
    const config = HighloadV3Config.fromPrivateKey(Buffer.alloc(32, 3));
    expect(config.secretKey).toHaveLength(64);
  });

  it("accepts hex and base64 facilitator private keys", () => {
    const seed = Buffer.alloc(32, 6);
    const fromHex = HighloadV3Config.fromPrivateKey(`0x${seed.toString("hex")}`);
    const fromBase64 = HighloadV3Config.fromPrivateKey(seed.toString("base64"));
    expect(fromHex.secretKey).toEqual(fromBase64.secretKey);
  });

  it("rejects invalid facilitator private key lengths", () => {
    expect(() => HighloadV3Config.fromPrivateKey(Buffer.alloc(16))).toThrow(
      /must be 32 bytes \(seed\) or 64 bytes \(secret key\)/,
    );
  });

  it("keeps the client signer protocol mockable", async () => {
    const mockSigner: ClientTvmSigner = {
      address: TEST_ADDRESS,
      network: TVM_TESTNET,
      walletId: 1,
      stateInit: { code: beginCell().endCell(), data: beginCell().endCell() },
      publicKey: "abcdef1234567890",
      signMessage: vi.fn().mockReturnValue(Buffer.alloc(64)),
      signTransfer: vi.fn().mockResolvedValue("boc"),
    };

    await expect(mockSigner.signTransfer(42, 1700000000, [])).resolves.toBe("boc");
  });
});

describe("highload-v3 codec", () => {
  it("maps seqno to query id and rejects out-of-range values", () => {
    expect(seqnoToQueryId(0)).toBe(0);
    expect(seqnoToQueryId(1022)).toBe(1022);
    expect(seqnoToQueryId(1023)).toBe(1024);
    expect(() => seqnoToQueryId(-1)).toThrow(/out of range/);
    expect(() => seqnoToQueryId(MAX_USABLE_QUERY_SEQNO + 1)).toThrow(/out of range/);
  });

  it("serializes internal transfer actions", () => {
    const actions = beginCell().endCell();
    const cell = serializeInternalTransfer(actions, 42);
    const slice = cell.beginParse();
    expect(slice.loadUint(32)).toBe(0xae42e5a4);
    expect(slice.loadUintBig(64)).toBe(42n);
    expect(slice.loadRef()).toEqual(actions);
  });

  it("returns null for inactive highload wallet state", () => {
    expect(
      loadHighloadQueryState({
        address: TEST_ADDRESS,
        balance: 0n,
        isActive: false,
        isUninitialized: true,
        isFrozen: false,
        stateInit: null,
      }),
    ).toBeNull();
  });

  it("rejects highload wallet state with unexpected code hash", () => {
    expect(() =>
      loadHighloadQueryState(buildHighloadAccountState(), {
        expectedCodeHash: "deadbeef",
      }),
    ).toThrow(/Unexpected code hash/);
  });

  it("tracks processed query ids and rolls old queries forward", () => {
    const now = 1_700_000_000;
    const processedQueryId = seqnoToQueryId(5);
    const queryState = loadHighloadQueryState(
      buildHighloadAccountState({ processedQueryId, lastCleanTime: now - 10, timeout: 3600 }),
      { now },
    );
    expect(queryState).not.toBeNull();
    expect(queryIdIsProcessed(queryState!, processedQueryId)).toBe(true);
    expect(queryIdIsProcessed(queryState!, seqnoToQueryId(6))).toBe(false);
  });

  it("clears stale query bitmaps after timeout windows", () => {
    const now = 1_700_000_000;
    const timeout = 100;
    const processedQueryId = seqnoToQueryId(1);
    const rolledState = loadHighloadQueryState(
      buildHighloadAccountState({
        processedQueryId,
        lastCleanTime: now - timeout - 1,
        timeout,
      }),
      { now },
    );
    expect(rolledState?.queries.size).toBe(0);
    expect(queryIdIsProcessed(rolledState!, processedQueryId)).toBe(true);

    const clearedState = loadHighloadQueryState(
      buildHighloadAccountState({
        processedQueryId,
        lastCleanTime: now - timeout * 2 - 1,
        timeout,
      }),
      { now },
    );
    expect(queryIdIsProcessed(clearedState!, processedQueryId)).toBe(false);
  });
});

describe("TVM provider clients", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("creates provider clients and resolves default base URLs", () => {
    expect(createTvmProviderClient(TVM_TESTNET)).toBeInstanceOf(ToncenterRestClient);
    expect(createTvmProviderClient(TVM_MAINNET, { provider: TVM_PROVIDER_TONAPI })).toBeInstanceOf(
      TonapiRestClient,
    );
    expect(defaultBaseUrl(TVM_MAINNET)).toBe("https://toncenter.com");
    expect(defaultBaseUrl(TVM_TESTNET, TVM_PROVIDER_TONAPI)).toBe("https://testnet.tonapi.io");
    expect(() => createTvmProviderClient(TVM_TESTNET, { provider: "unknown" })).toThrow(
      /Unsupported TVM provider/,
    );
    expect(() => defaultBaseUrl("tvm:999")).toThrow(/Unsupported TVM provider/);
  });

  it("loads Toncenter account state, jetton data, traces, and messages", async () => {
    const codeBoc = beginCell().endCell().toBoc().toString("base64");
    const dataBoc = beginCell().storeUint(1, 8).endCell().toBoc().toString("base64");
    installFetchMock((url, init) => {
      if (url.includes("/api/v3/accountStates")) {
        return jsonResponse({ accounts: [activeAccountPayload(codeBoc, dataBoc)] });
      }
      if (url.includes("/api/v3/runGetMethod")) {
        const body = JSON.parse(String(init?.body));
        if (body.method === "get_wallet_address") {
          return jsonResponse({
            exit_code: 0,
            stack: [addressStackItem(OWNER_ADDRESS)],
          });
        }
        if (body.method === "get_wallet_data") {
          return jsonResponse({
            exit_code: 0,
            stack: [
              { type: "num", value: "1000" },
              addressStackItem(OWNER_ADDRESS),
              addressStackItem(ASSET_ADDRESS),
            ],
          });
        }
        return jsonResponse({ exit_code: 1, stack: [] });
      }
      if (url.includes("/api/emulate/v1/emulateTrace")) {
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/v3/traces")) {
        return jsonResponse({ traces: [{ hash: "trace-1", transactions: {} }] });
      }
      if (url.includes("/api/v3/message")) {
        return jsonResponse({ message_hash_norm: "abc123" });
      }
      return new Response("not found", { status: 404 });
    });

    const client = createTvmProviderClient(TVM_TESTNET, {
      apiKey: "secret",
      baseUrl: "https://mock.toncenter.test/",
    });

    const activeState = await client.getAccountState(TEST_ADDRESS);
    expect(activeState.isActive).toBe(true);
    expect(activeState.stateInit?.code).toBeDefined();

    installFetchMock(() => jsonResponse({ accounts: [] }));
    const emptyState = await createTvmProviderClient(TVM_TESTNET, {
      baseUrl: "https://mock-empty.test",
    }).getAccountState(TEST_ADDRESS);
    expect(emptyState.isUninitialized).toBe(true);

    installFetchMock((url, init) => {
      if (url.includes("/api/v3/runGetMethod")) {
        const body = JSON.parse(String(init?.body));
        if (body.method === "get_wallet_data") {
          return jsonResponse({ exit_code: 0, stack: [{ type: "num", value: "1" }] });
        }
      }
      return jsonResponse({ accounts: [] });
    });
    const retryClient = createTvmProviderClient(TVM_TESTNET, {
      baseUrl: "https://mock-empty.test",
    });
    await expect(retryClient.getJettonWalletData(TEST_ADDRESS)).rejects.toThrow(/incomplete stack/);

    installFetchMock((url, init) => {
      if (url.includes("/api/v3/runGetMethod")) {
        const body = JSON.parse(String(init?.body));
        if (body.method === "bad_method") {
          return jsonResponse({ exit_code: 1, stack: [] });
        }
        if (body.method === "invalid_stack_method") {
          return jsonResponse({ exit_code: 0, stack: "invalid" });
        }
      }
      return jsonResponse({});
    });
    const methodClient = createTvmProviderClient(TVM_TESTNET, {
      baseUrl: "https://mock-empty.test",
    });
    await expect(methodClient.runGetMethod(TEST_ADDRESS, "bad_method", [])).rejects.toThrow(
      /failed with exit code 1/,
    );
    await expect(
      methodClient.runGetMethod(TEST_ADDRESS, "invalid_stack_method", []),
    ).rejects.toThrow(/invalid stack/);

    installFetchMock((url, init) => {
      if (url.includes("/api/v3/message")) return jsonResponse({ message_hash: "legacy-hash" });
      if (url.includes("/api/emulate/v1/emulateTrace")) {
        const body = JSON.parse(String(init?.body));
        expect(body.ignore_chksig).toBe(true);
        return jsonResponse({ emulated: true });
      }
      if (url.includes("/api/v3/traces")) {
        if (url.includes("invalid")) return jsonResponse({ traces: "invalid" });
        return jsonResponse({ traces: [] });
      }
      return jsonResponse({});
    });
    const messageClient = createTvmProviderClient(TVM_TESTNET, {
      baseUrl: "https://mock-empty.test",
    });
    const relayBoc = beginCell()
      .store(
        storeMessage(
          external({
            to: Address.parse(TEST_ADDRESS),
            body: beginCell().endCell(),
          }),
        ),
      )
      .endCell()
      .toBoc();
    await expect(messageClient.sendMessage(relayBoc)).resolves.toBe("legacy-hash");
    await expect(
      messageClient.emulateTrace(relayBoc, { ignoreChksig: true, timeout: 5 }),
    ).resolves.toEqual({ emulated: true });
    await expect(messageClient.getTraceByMessageHash("invalid")).rejects.toThrow(
      /invalid traces response/,
    );
    await expect(messageClient.getTraceByMessageHash("missing")).rejects.toThrow(
      /returned no trace/,
    );

    client.close();
  });

  it("retries retryable Toncenter HTTP failures", async () => {
    vi.useFakeTimers();
    let calls = 0;
    installFetchMock(() => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
      }
      return jsonResponse({ accounts: [] });
    });

    const client = createTvmProviderClient(TVM_TESTNET, { baseUrl: "https://mock-retry.test" });
    const promise = client.getAccountState(TEST_ADDRESS);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ isUninitialized: true });
    expect(calls).toBeGreaterThan(1);
  });

  it("loads TonAPI account state, methods, traces, and external message hashes", async () => {
    const codeBoc = beginCell().endCell().toBoc().toString("base64");
    const dataBoc = beginCell().storeUint(2, 8).endCell().toBoc().toString("base64");
    installFetchMock((url, init) => {
      if (url.includes("/v2/blockchain/accounts/") && init?.method === "GET") {
        if (url.endsWith(TEST_ADDRESS)) {
          return jsonResponse({
            status: "active",
            balance: "2000",
            code: codeBoc,
            data: dataBoc,
          });
        }
        return new Response("missing", { status: 404 });
      }
      if (url.includes("/methods/get_wallet_address")) {
        return jsonResponse({
          success: true,
          exit_code: 0,
          stack: [{ type: "slice", slice: OWNER_ADDRESS }],
        });
      }
      if (url.includes("/methods/get_wallet_data")) {
        return jsonResponse({
          success: true,
          exit_code: 0,
          stack: [
            { type: "num", num: "500" },
            { type: "slice", slice: OWNER_ADDRESS },
            { type: "slice", slice: ASSET_ADDRESS },
          ],
        });
      }
      if (url.includes("/methods/broken_method")) {
        return jsonResponse({ success: false, exit_code: 42, stack: [] });
      }
      if (url.includes("/methods/invalid_stack")) {
        return jsonResponse({ success: true, exit_code: 0, stack: null });
      }
      if (url.includes("/v2/blockchain/message")) {
        return new Response("", { status: 200 });
      }
      if (url.includes("/v2/traces/emulate")) {
        return jsonResponse({
          transaction: {
            hash: "tx-root",
            account: { address: TEST_ADDRESS },
            aborted: false,
            compute_phase: { skipped: false, success: true, gas_fees: "100" },
            action_phase: { success: true, fwd_fees: "50", total_fees: "50" },
            storage_phase: { fees_collected: "0", fees_due: "0" },
            in_msg: {
              hash: "in-hash",
              source: { address: OWNER_ADDRESS },
              destination: { address: TEST_ADDRESS },
              op_code: "0xf8a7ea5",
              decoded_op_name: "JettonTransfer",
              raw_body: codeBoc,
            },
            out_msgs: [],
          },
          children: [
            {
              transaction: {
                hash: "child-hash",
                account: { address: OWNER_ADDRESS },
                aborted: false,
                compute_phase: { skipped: false, success: true, gas_fees: "10" },
                action_phase: { success: true, fwd_fees: "5", total_fees: "5" },
                in_msg: { hash: "child-in", source: { address: TEST_ADDRESS } },
                out_msgs: [],
              },
              children: [],
            },
          ],
        });
      }
      if (url.includes("/v2/traces/")) {
        return jsonResponse({
          transaction: {
            hash: "trace-hash",
            account: { address: TEST_ADDRESS },
            aborted: false,
            compute_phase: { skipped: false, success: true, gas_fees: "1" },
            in_msg: { hash: "in", op_code: 0x7369676e },
            out_msgs: [{ hash: "child-in", source: { address: TEST_ADDRESS } }],
          },
          children: [
            {
              transaction: {
                hash: "child-hash",
                account: { address: OWNER_ADDRESS },
                aborted: false,
                compute_phase: { skipped: false, success: true, gas_fees: "1" },
                in_msg: { hash: "child-in", source: { address: TEST_ADDRESS } },
                out_msgs: [],
              },
              children: [],
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const client = createTvmProviderClient(TVM_MAINNET, {
      provider: TVM_PROVIDER_TONAPI,
      apiKey: "token",
      baseUrl: "https://mock.tonapi.test",
    });

    const activeState = await client.getAccountState(TEST_ADDRESS);
    expect(activeState.isActive).toBe(true);

    const missingClient = createTvmProviderClient(TVM_MAINNET, {
      provider: TVM_PROVIDER_TONAPI,
      baseUrl: "https://mock.tonapi.test",
    });
    await expect(
      missingClient.getAccountState(
        "0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      ),
    ).resolves.toMatchObject({ isUninitialized: true });

    await expect(client.getJettonWallet(ASSET_ADDRESS, OWNER_ADDRESS)).resolves.toBe(OWNER_ADDRESS);
    await expect(client.getJettonWalletData(TEST_ADDRESS)).resolves.toMatchObject({
      balance: 500n,
      owner: OWNER_ADDRESS,
    });
    await expect(client.runGetMethod(TEST_ADDRESS, "broken_method", [])).rejects.toThrow(
      /failed with exit code 42/,
    );
    await expect(client.runGetMethod(TEST_ADDRESS, "invalid_stack", [])).rejects.toThrow(
      /invalid stack/,
    );

    const relayBoc = beginCell()
      .store(
        storeMessage(
          external({
            to: Address.parse(TEST_ADDRESS),
            body: beginCell().endCell(),
          }),
        ),
      )
      .endCell()
      .toBoc();
    const messageHash = await client.sendMessage(relayBoc);
    expect(messageHash).toMatch(/^[0-9a-f]{64}$/);

    const emulated = await client.emulateTrace(relayBoc, { ignoreChksig: true });
    expect(emulated.transactions).toBeDefined();
    const trace = await client.getTraceByMessageHash("trace-id");
    expect(trace.transactions).toBeDefined();

    await expect(
      client.runGetMethod(TEST_ADDRESS, "get_wallet_address", [
        { type: "slice", value: addressStackItem(OWNER_ADDRESS).value },
      ]),
    ).resolves.toHaveLength(1);

    await expect(
      client.runGetMethod(TEST_ADDRESS, "get_wallet_address", [{ type: "num", value: "7" }]),
    ).resolves.toBeDefined();

    client.close();
  });

  it("surfaces non-retryable TonAPI HTTP failures", async () => {
    installFetchMock(() => new Response("bad request", { status: 400 }));
    const client = createTvmProviderClient(TVM_MAINNET, {
      provider: TVM_PROVIDER_TONAPI,
      baseUrl: "https://mock.tonapi.test",
    });
    await expect(client.getAccountState(TEST_ADDRESS)).rejects.toThrow(/400/);
  });
});

describe("FacilitatorHighloadV3Signer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("exposes configured addresses and rejects unsupported networks", () => {
    const config = HighloadV3Config.fromPrivateKey(Buffer.alloc(32, 8), {
      providerBaseUrl: "https://mock-facilitator.test",
    });
    const signer = toFacilitatorTvmSigner(config, TVM_TESTNET);
    expect(signer.getAddresses()).toHaveLength(1);
    expect(signer.getAddressesForNetwork(TVM_TESTNET)).toHaveLength(1);
    expect(() => signer.getAddressesForNetwork("tvm:999")).toThrow(/Unsupported network/);
    signer.close();
  });

  it("rejects empty and oversized relay batches", async () => {
    const signer = toFacilitatorTvmSigner(
      HighloadV3Config.fromPrivateKey(Buffer.alloc(32, 9), {
        providerBaseUrl: "https://mock-facilitator.test",
      }),
      TVM_TESTNET,
    );
    await expect(signer.buildRelayExternalBocBatch(TVM_TESTNET, [])).rejects.toThrow(
      /must not be empty/,
    );
    await expect(
      signer.buildRelayExternalBocBatch(
        TVM_TESTNET,
        Array.from({ length: DEFAULT_SETTLEMENT_BATCH_MAX_SIZE + 1 }, () => relayRequest()),
      ),
    ).rejects.toThrow(/must not exceed/);
  });

  it("builds relay BoCs against uninitialized facilitator wallets", async () => {
    const config = HighloadV3Config.fromPrivateKey(Buffer.alloc(32, 10), {
      providerBaseUrl: "https://mock-facilitator.test",
    });
    const signer = toFacilitatorTvmSigner(config, TVM_TESTNET);
    const facilitator = signer.getAddresses()[0]!;

    installFetchMock(url => {
      if (url.includes("/api/v3/accountStates")) {
        return jsonResponse({
          accounts: [
            {
              status: "uninit",
              balance: "0",
            },
          ],
        });
      }
      return jsonResponse({});
    });

    const externalBoc = await signer.buildRelayExternalBoc(TVM_TESTNET, relayRequest(), {
      forEmulation: true,
    });
    expect(externalBoc.length).toBeGreaterThan(0);
    expect(facilitator).toMatch(/^0:/);
  });

  it("waits for a complete trace", async () => {
    vi.useFakeTimers();
    let calls = 0;

    installFetchMock(url => {
      if (url.includes("/api/v3/traces")) {
        calls += 1;
        if (calls === 1) {
          return jsonResponse({ traces: [{ is_incomplete: true }] });
        }
        return jsonResponse({ traces: [{ is_incomplete: false, transactions: {} }] });
      }
      return jsonResponse({ accounts: [] });
    });

    const signer = toFacilitatorTvmSigner(
      HighloadV3Config.fromPrivateKey(Buffer.alloc(32, 11), {
        providerBaseUrl: "https://mock-facilitator.test",
      }),
      TVM_TESTNET,
    );
    const confirmation = signer.waitForTraceConfirmation(TVM_TESTNET, "trace-hash", {
      timeoutSeconds: 2,
    });
    await vi.advanceTimersByTimeAsync(600);
    await expect(confirmation).resolves.toMatchObject({ is_incomplete: false });
  });

  it("times out when trace confirmation never completes", async () => {
    vi.useFakeTimers();
    installFetchMock(() => new Response("missing", { status: 404 }));

    const signer = toFacilitatorTvmSigner(
      HighloadV3Config.fromPrivateKey(Buffer.alloc(32, 12), {
        providerBaseUrl: "https://mock-facilitator.test",
      }),
      TVM_TESTNET,
    );
    const timeoutPromise = signer.waitForTraceConfirmation(TVM_TESTNET, "missing-trace", {
      timeoutSeconds: 1,
    });
    const assertion = expect(timeoutPromise).rejects.toThrow(/404|Timed out/);
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
  });
});

describe("TVM package exports and utils", () => {
  it("re-exports the public package surface", () => {
    expect(tvmPackage.ExactTvmScheme).toBeDefined();
    expect(tvmPackage.createTvmProviderClient).toBeDefined();
    expect(tvmPackage.normalizeTonAddress).toBeDefined();
    expect(ExactScheme).toBe(ExactClientScheme);
    expect(ExactFacilitatorScheme).toBeDefined();
    expect(ExactServerScheme).toBeDefined();
  });

  it("normalizes addresses and decimal amounts", () => {
    expect(normalizeTonAddress(TEST_ADDRESS)).toBe(TEST_ADDRESS);
    expect(priceToNano("$1.50")).toBe(1_500_000n);
    expect(parseDecimalAmount("0.01", 6)).toBe(10_000n);
    expect(isValidTvmNetwork(TVM_TESTNET)).toBe(true);
    expect(isTvmTestnet(TVM_TESTNET)).toBe(true);
    expect(makeZeroBitCellBoc()).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(() => parseDecimalAmount("not-a-number", 6)).toThrow(/Invalid amount/);
  });
});

function relayRequest(): TvmRelayRequest {
  return {
    destination: OWNER_ADDRESS,
    body: beginCell().endCell(),
    stateInit: null,
  };
}
