import { AccountRole, generateKeyPairSigner } from "@solana/kit";
import type { Address, TransactionSigner } from "@solana/kit";
import type { Network } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import {
  buildReclaimInstruction,
  ChannelStatus,
  RECLAIM_DISCRIMINATOR,
} from "../../src/payment-channels/onchain";
import { OPEN_SLOT_WINDOW } from "../../src/payment-channels/open";
import type { FacilitatorSvmSigner } from "../../src/signer";
import { toFacilitatorSvmSigner } from "../../src/signer";
import { InMemoryUptoChannelStorage } from "../../src/upto/facilitator/channelStorage";
import type { UptoChannelRecord } from "../../src/upto/facilitator/channelStorage";
import {
  MAX_SAFE_RECLAIMS_PER_TX,
  UptoSvmRentCleanupManager,
} from "../../src/upto/facilitator/rentCleanupManager";
import { UptoSvmScheme } from "../../src/upto/facilitator/scheme";

const NETWORK = SOLANA_DEVNET_CAIP2 as Network;
const OPEN_SLOT = 100n;
const CURRENT_SLOT_READY = OPEN_SLOT + OPEN_SLOT_WINDOW + 1n;
const CURRENT_SLOT_TOO_EARLY = OPEN_SLOT + OPEN_SLOT_WINDOW;
const FAR_FUTURE = 4_102_444_800;

const fetchMaybeChannelMock = vi.hoisted(() => vi.fn());
const submitSettleMock = vi.hoisted(() => vi.fn());
const buildDistributeMock = vi.hoisted(() => vi.fn());
const getSlotMock = vi.hoisted(() => vi.fn());
const discoverChannelsMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/payment-channels/discovery", async () => {
  const actual = await vi.importActual<typeof import("../../src/payment-channels/discovery")>(
    "../../src/payment-channels/discovery",
  );
  return {
    ...actual,
    discoverChannelsByRentPayer: discoverChannelsMock,
  };
});

vi.mock("../../src/payment-channels/generated/accounts/channel", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/payment-channels/generated/accounts/channel")
  >("../../src/payment-channels/generated/accounts/channel");
  return {
    ...actual,
    fetchMaybeChannel: fetchMaybeChannelMock,
  };
});

vi.mock("../../src/upto/facilitator/channel", async () => {
  const actual = await vi.importActual<typeof import("../../src/upto/facilitator/channel")>(
    "../../src/upto/facilitator/channel",
  );
  return {
    ...actual,
    submitSettle: submitSettleMock,
  };
});

vi.mock("../../src/payment-channels/onchain", async () => {
  const actual = await vi.importActual<typeof import("../../src/payment-channels/onchain")>(
    "../../src/payment-channels/onchain",
  );
  return {
    ...actual,
    buildDistributeInstruction: buildDistributeMock,
  };
});

vi.mock("../../src/utils", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils")>("../../src/utils");
  return {
    ...actual,
    createRpcClient: () => ({
      getSlot: () => ({ send: getSlotMock }),
    }),
  };
});

describe("payment-channel reclaim primitive", () => {
  it("exports OPEN_SLOT_WINDOW and builds reclaim with disc 9", async () => {
    expect(OPEN_SLOT_WINDOW).toBe(1_500n);
    expect(ChannelStatus.Open).toBe(0);
    expect(ChannelStatus.Distributed).toBe(3);

    const channel = await generateKeyPairSigner();
    const rentPayer = await generateKeyPairSigner();
    const ix = buildReclaimInstruction({
      channelId: channel.address,
      rentPayer: rentPayer.address,
    });
    expect(ix.data[0]).toBe(RECLAIM_DISCRIMINATOR);
    expect(ix.accounts).toHaveLength(2);
    expect(ix.accounts[0]?.role).toBe(AccountRole.WRITABLE);
    expect(ix.accounts[1]?.role).toBe(AccountRole.WRITABLE);
  });
});

describe("UptoChannelStorage + scheme wiring", () => {
  it("upserts on verify success, retains after settle, deletes when PDA gone", async () => {
    const feePayer = await generateKeyPairSigner();
    const channel = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const storage = new InMemoryUptoChannelStorage();
    const scheme = new UptoSvmScheme(toFacilitatorSvmSigner(feePayer), {
      channelStorage: storage,
    });

    const record: UptoChannelRecord = {
      channelId: channel.address,
      payTo: payTo.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      firstSeenAt: Date.now() - 10_000,
      expiresAt: FAR_FUTURE,
      network: NETWORK,
    };
    await storage.upsert(record);
    expect(await storage.get(record.channelId)).toMatchObject({
      payTo: record.payTo,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const firstSeenAt = (await storage.get(record.channelId))!.firstSeenAt;
    await storage.upsert({ ...record, firstSeenAt: Date.now(), expiresAt: FAR_FUTURE - 100 });
    expect((await storage.get(record.channelId))!.firstSeenAt).toBe(firstSeenAt);
    expect((await storage.get(record.channelId))!.expiresAt).toBe(FAR_FUTURE);

    const manager = scheme.createRentCleanupManager(NETWORK);
    fetchMaybeChannelMock.mockResolvedValue({ exists: false });
    await manager.cleanup();
    expect(await storage.get(record.channelId)).toBeUndefined();
  });

  it("createRentCleanupManager returns a manager bound to the scheme storage", async () => {
    const feePayer = await generateKeyPairSigner();
    const scheme = new UptoSvmScheme(toFacilitatorSvmSigner(feePayer));
    const manager = scheme.createRentCleanupManager(NETWORK);
    expect(manager).toBeInstanceOf(UptoSvmRentCleanupManager);
    expect(scheme.getChannelStorage()).toBeInstanceOf(InMemoryUptoChannelStorage);
  });
});

describe("UptoSvmRentCleanupManager — cleanup", () => {
  let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let payTo: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let storage: InMemoryUptoChannelStorage;
  let manager: UptoSvmRentCleanupManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    feePayer = await generateKeyPairSigner();
    payer = await generateKeyPairSigner();
    payTo = await generateKeyPairSigner();
    storage = new InMemoryUptoChannelStorage();
    manager = new UptoSvmRentCleanupManager({
      network: NETWORK,
      signer: toFacilitatorSvmSigner(feePayer),
      storage,
    });
    submitSettleMock.mockResolvedValue("Sig11111111111111111111111111111111111111111");
    buildDistributeMock.mockResolvedValue({
      accounts: [],
      data: new Uint8Array([7]),
      programAddress: "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX",
    });
    getSlotMock.mockResolvedValue(CURRENT_SLOT_READY);
  });

  /**
   * @param overrides - Partial live channel account fields
   */
  function channelAccount(overrides: {
    status: ChannelStatus;
    openSlot?: bigint;
    payee?: string;
    rentPayer?: string;
    payer?: string;
    mint?: string;
  }) {
    return {
      exists: true as const,
      data: {
        status: overrides.status,
        openSlot: overrides.openSlot ?? OPEN_SLOT,
        payee: overrides.payee ?? feePayer.address,
        rentPayer: overrides.rentPayer ?? feePayer.address,
        payer: overrides.payer ?? payer.address,
        mint: overrides.mint ?? USDC_DEVNET_ADDRESS,
      },
    };
  }

  /**
   * @param overrides - Record field overrides
   */
  async function seed(overrides: Partial<UptoChannelRecord> = {}) {
    const channel = overrides.channelId
      ? { address: overrides.channelId }
      : await generateKeyPairSigner();
    const record: UptoChannelRecord = {
      channelId: channel.address,
      payTo: overrides.payTo ?? payTo.address,
      tokenProgram: overrides.tokenProgram ?? TOKEN_PROGRAM_ADDRESS,
      firstSeenAt: overrides.firstSeenAt ?? Date.now() - 7_200_000,
      expiresAt: overrides.expiresAt ?? FAR_FUTURE,
      network: overrides.network ?? NETWORK,
    };
    await storage.upsert(record);
    return record;
  }

  it("does not abandon-close Open channels before expiry plus grace", async () => {
    const nowSecs = Math.floor(Date.now() / 1_000);
    const record = await seed({
      firstSeenAt: Date.now() - 60_000,
      expiresAt: nowSecs + 300,
    });
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Open }));

    const onClose = vi.fn();
    await manager.cleanup({ abandonGraceSecs: 120, onClose });
    expect(onClose).not.toHaveBeenCalled();
    expect(submitSettleMock).not.toHaveBeenCalled();
    expect(await storage.get(record.channelId)).toBeDefined();
  });

  it("does not abandon-close non-expiring Open batch channels", async () => {
    const record = await seed({ expiresAt: 0 });
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Open }));

    const onClose = vi.fn();
    await manager.cleanup({ abandonGraceSecs: 120, onClose });

    expect(onClose).not.toHaveBeenCalled();
    expect(submitSettleMock).not.toHaveBeenCalled();
    expect(await storage.get(record.channelId)).toBeDefined();
  });

  it("abandon-closes Open channels after expiry plus grace", async () => {
    const nowSecs = Math.floor(Date.now() / 1_000);
    const record = await seed({
      firstSeenAt: Date.now() - 60_000,
      expiresAt: nowSecs - 200,
    });
    fetchMaybeChannelMock
      .mockResolvedValueOnce(channelAccount({ status: ChannelStatus.Open }))
      .mockResolvedValueOnce({ exists: false });

    const onClose = vi.fn();
    await manager.cleanup({ abandonGraceSecs: 120, onClose });

    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: record.channelId, action: "abandon_close" }),
    );
    expect(submitSettleMock).toHaveBeenCalledTimes(1);
    const instructions = submitSettleMock.mock.calls[0]![3] as unknown[];
    expect(instructions.length).toBeGreaterThanOrEqual(2);
    expect(await storage.get(record.channelId)).toBeUndefined();
  });

  it("does not abandon-close Open channels before expiresAt even when firstSeen is old", async () => {
    const nowSecs = Math.floor(Date.now() / 1_000);
    const record = await seed({
      firstSeenAt: Date.now() - 7_200_000,
      expiresAt: nowSecs + 300,
    });
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Open }));

    const onClose = vi.fn();
    await manager.cleanup({ abandonGraceSecs: 120, onClose });

    expect(onClose).not.toHaveBeenCalled();
    expect(submitSettleMock).not.toHaveBeenCalled();
    expect(await storage.get(record.channelId)).toBeDefined();
  });

  it("distributes Sealed channels", async () => {
    const record = await seed();
    fetchMaybeChannelMock
      .mockResolvedValueOnce(channelAccount({ status: ChannelStatus.Sealed }))
      .mockResolvedValueOnce({ exists: false });

    const onClose = vi.fn();
    await manager.cleanup({ onClose });
    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: record.channelId, action: "distribute" }),
    );
    const instructions = submitSettleMock.mock.calls[0]![3] as unknown[];
    expect(instructions).toHaveLength(1);
  });

  it("defers Closing channels", async () => {
    await seed();
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Closing }));
    const onClose = vi.fn();
    const onReclaim = vi.fn();
    await manager.cleanup({ onClose, onReclaim });
    expect(onClose).not.toHaveBeenCalled();
    expect(onReclaim).not.toHaveBeenCalled();
    expect(submitSettleMock).not.toHaveBeenCalled();
  });

  it("defers Distributed reclaim until the open-slot gate elapses", async () => {
    await seed();
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Distributed }));
    getSlotMock.mockResolvedValue(CURRENT_SLOT_TOO_EARLY);

    const onReclaim = vi.fn();
    await manager.cleanup({ onReclaim });
    expect(onReclaim).not.toHaveBeenCalled();
    expect(submitSettleMock).not.toHaveBeenCalled();
  });

  it("batch-reclaims Distributed channels after the open-slot gate", async () => {
    const a = await seed();
    const b = await seed();
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Distributed }));
    getSlotMock.mockResolvedValue(CURRENT_SLOT_READY);

    const onReclaim = vi.fn();
    await manager.cleanup({ maxReclaimsPerTx: 8, onReclaim });

    expect(onReclaim).toHaveBeenCalledTimes(1);
    expect(onReclaim.mock.calls[0]![0].channelIds).toEqual(
      expect.arrayContaining([a.channelId, b.channelId]),
    );
    const instructions = submitSettleMock.mock.calls[0]![3] as { data: Uint8Array }[];
    expect(instructions).toHaveLength(2);
    expect(instructions.every(ix => ix.data[0] === RECLAIM_DISCRIMINATOR)).toBe(true);
    // Reclaim batches carry a per-channel compute-unit limit (base + 2 × per-channel).
    expect(submitSettleMock.mock.calls[0]![4]).toMatchObject({ computeUnitLimit: 35_000 });
    expect(await storage.get(a.channelId)).toBeUndefined();
    expect(await storage.get(b.channelId)).toBeUndefined();
  });

  // A failed batch strands every channel in it, so reporting only the first
  // would hide the rest from the operator watching onError.
  it("reports every channel in a reclaim batch that failed to broadcast", async () => {
    const a = await seed();
    const b = await seed();
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Distributed }));
    getSlotMock.mockResolvedValue(CURRENT_SLOT_READY);
    submitSettleMock.mockRejectedValue(new Error("broadcast failed"));

    const onError = vi.fn();
    const onReclaim = vi.fn();
    await manager.cleanup({ maxReclaimsPerTx: 8, onError, onReclaim });

    expect(onReclaim).not.toHaveBeenCalled();
    expect(onError.mock.calls.map(call => call[1]?.channelId)).toEqual(
      expect.arrayContaining([a.channelId, b.channelId]),
    );
  });

  it("respects maxReclaimsPerTx and maxTxsPerSigner for reclaim batching", async () => {
    await seed();
    await seed();
    await seed();
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Distributed }));
    getSlotMock.mockResolvedValue(CURRENT_SLOT_READY);

    const onReclaim = vi.fn();
    await manager.cleanup({ maxReclaimsPerTx: 2, maxTxsPerSigner: 1, onReclaim });

    expect(onReclaim).toHaveBeenCalledTimes(1);
    expect(onReclaim.mock.calls[0]![0].channelIds).toHaveLength(2);
    expect(submitSettleMock).toHaveBeenCalledTimes(1);
  });

  // An operator-configured maxReclaimsPerTx above MAX_SAFE_RECLAIMS_PER_TX
  // must be clamped, not honored: a larger batch risks failing to serialize
  // or being rejected on broadcast (see the Go SDK's
  // TestReclaimBatchFitsInOneTransaction, which proves the same ceiling).
  it("clamps maxReclaimsPerTx to MAX_SAFE_RECLAIMS_PER_TX", async () => {
    for (let i = 0; i < MAX_SAFE_RECLAIMS_PER_TX + 1; i++) {
      await seed();
    }
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Distributed }));
    getSlotMock.mockResolvedValue(CURRENT_SLOT_READY);

    const onReclaim = vi.fn();
    await manager.cleanup({ maxReclaimsPerTx: 1_000, maxTxsPerSigner: 10, onReclaim });

    expect(onReclaim).toHaveBeenCalledTimes(2);
    const batchSizes = onReclaim.mock.calls.map(call => call[0].channelIds.length as number);
    expect(Math.max(...batchSizes)).toBe(MAX_SAFE_RECLAIMS_PER_TX);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(MAX_SAFE_RECLAIMS_PER_TX + 1);
  });

  // A misconfigured non-positive maxReclaimsPerTx must fall back to the
  // default instead of spinning the batching loop forever (`i += 0`).
  it("falls back to the default when maxReclaimsPerTx is non-positive", async () => {
    await seed();
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Distributed }));
    getSlotMock.mockResolvedValue(CURRENT_SLOT_READY);

    const onReclaim = vi.fn();
    await manager.cleanup({ maxReclaimsPerTx: 0, onReclaim });

    expect(onReclaim).toHaveBeenCalledTimes(1);
  });

  // The two budgets bound different things: maxTxsPerRun stops the storage
  // scan, maxTxsPerSigner caps each rent payer's reclaims. A scan budget of 1
  // must not also throttle reclaims, which cost the scan nothing to classify.
  it("budgets the scan and reclaims separately", async () => {
    await seed();
    await seed();
    await seed();
    await seed();
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Distributed }));
    getSlotMock.mockResolvedValue(CURRENT_SLOT_READY);

    const onReclaim = vi.fn();
    await manager.cleanup({ maxReclaimsPerTx: 1, maxTxsPerRun: 1, maxTxsPerSigner: 4, onReclaim });

    expect(onReclaim).toHaveBeenCalledTimes(4);
  });

  it("skips reclaim when a concurrent settle already changed status (stale refetch)", async () => {
    const record = await seed();
    fetchMaybeChannelMock
      .mockResolvedValueOnce(channelAccount({ status: ChannelStatus.Distributed }))
      .mockResolvedValueOnce({ exists: false });
    getSlotMock.mockResolvedValue(CURRENT_SLOT_READY);

    const onReclaim = vi.fn();
    await manager.cleanup({ onReclaim });
    expect(onReclaim).not.toHaveBeenCalled();
    expect(submitSettleMock).not.toHaveBeenCalled();
    expect(await storage.get(record.channelId)).toBeUndefined();
  });

  it("skips channels with missing payTo and surfaces onError", async () => {
    const nowSecs = Math.floor(Date.now() / 1_000);
    await seed({ payTo: "", firstSeenAt: Date.now() - 7_200_000, expiresAt: nowSecs - 200 });
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Open }));

    const onError = vi.fn();
    const onClose = vi.fn();
    await manager.cleanup({ abandonGraceSecs: 120, onClose, onError });
    expect(onClose).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("missing payTo") }),
      expect.objectContaining({ channelId: expect.any(String) }),
    );
  });

  // The close cap must not end the record scan: reclaims are budgeted separately,
  // so a backlog of closable channels would otherwise strand rent forever.
  it("still reclaims when the close budget is spent", async () => {
    const nowSecs = Math.floor(Date.now() / 1_000);
    const closable = await seed({ expiresAt: nowSecs - 200 });
    const distributed = await seed({ expiresAt: nowSecs - 200 });
    fetchMaybeChannelMock.mockImplementation((_rpc: unknown, channelId: string) => {
      if (channelId === closable.channelId) {
        return Promise.resolve(channelAccount({ status: ChannelStatus.Open }));
      }
      if (channelId === distributed.channelId) {
        return Promise.resolve(channelAccount({ status: ChannelStatus.Distributed }));
      }
      return Promise.resolve({ exists: false });
    });
    getSlotMock.mockResolvedValue(CURRENT_SLOT_READY);

    const onReclaim = vi.fn();
    await manager.cleanup({ abandonGraceSecs: 120, maxClosesPerRun: 0, onReclaim });

    expect(onReclaim).toHaveBeenCalledTimes(1);
    expect(onReclaim.mock.calls[0]![0].channelIds).toEqual([distributed.channelId]);
  });

  // A backlog bigger than maxTxsPerRun must eventually reach every record
  // instead of only ever reprocessing whatever storage.list() returns first.
  it("resumes scanning from the cursor after the budget runs out", async () => {
    const nowSecs = Math.floor(Date.now() / 1_000);
    const first = await seed({ expiresAt: nowSecs - 200 });
    const second = await seed({ expiresAt: nowSecs - 200 });
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Sealed }));
    submitSettleMock.mockResolvedValue("Sig11111111111111111111111111111111111111111");

    const firstPassCloses = vi.fn();
    await manager.cleanup({ maxTxsPerRun: 1, onClose: firstPassCloses });
    expect(firstPassCloses).toHaveBeenCalledTimes(1);
    const closedFirst = firstPassCloses.mock.calls[0]![0].channelId as string;
    expect([first.channelId, second.channelId]).toContain(closedFirst);
    const cursor = (manager as unknown as { scanCursor: string }).scanCursor;
    expect(cursor).not.toBe(closedFirst);

    const secondPassCloses = vi.fn();
    await manager.cleanup({ onClose: secondPassCloses });
    expect(secondPassCloses.mock.calls[0]![0].channelId).toBe(cursor);
    expect((manager as unknown as { scanCursor: string }).scanCursor).toBe("");
  });

  // storage.list() promises no order, so the manager imposes one. Without it
  // the resume cursor would mean something different on every storage backend.
  it("scans in channel id order regardless of what storage.list returns", async () => {
    const nowSecs = Math.floor(Date.now() / 1_000);
    const first = await seed({ expiresAt: nowSecs - 200 });
    const second = await seed({ expiresAt: nowSecs - 200 });
    const lowest = [first.channelId, second.channelId].sort()[0];

    const descending = (await storage.list()).sort((a, b) => (a.channelId < b.channelId ? 1 : -1));
    vi.spyOn(storage, "list").mockResolvedValue(descending);
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Sealed }));

    const onClose = vi.fn();
    await manager.cleanup({ maxTxsPerRun: 1, onClose });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.calls[0]![0].channelId).toBe(lowest);
  });

  // An unrecognized status has no cleanup path, so the record would sit in storage
  // forever without the operator ever hearing about it.
  it("reports an unrecognized channel status", async () => {
    const record = await seed();
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: 99 as ChannelStatus }));

    const onError = vi.fn();
    const onClose = vi.fn();
    const onReclaim = vi.fn();
    await manager.cleanup({ onClose, onError, onReclaim });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("unrecognized status") }),
      expect.objectContaining({ channelId: record.channelId }),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(onReclaim).not.toHaveBeenCalled();
    expect(await storage.get(record.channelId)).toBeDefined();
  });

  // An operator cron calling cleanup() must not race the interval loop into
  // submitting the same close twice.
  it("runs overlapping passes serially", async () => {
    const nowSecs = Math.floor(Date.now() / 1_000);
    await seed({ expiresAt: nowSecs - 200 });
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Sealed }));

    let inFlight = 0;
    let overlapped = false;
    submitSettleMock.mockImplementation(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise(resolve => setTimeout(resolve, 10));
      inFlight -= 1;
      return "Sig11111111111111111111111111111111111111111";
    });

    await Promise.all([manager.cleanup({}), manager.cleanup({}), manager.cleanup({})]);

    expect(overlapped).toBe(false);
  });

  it("stops a scan in progress at the next record when the caller aborts", async () => {
    const nowSecs = Math.floor(Date.now() / 1_000);
    await seed({ expiresAt: nowSecs - 200 });
    await seed({ expiresAt: nowSecs - 200 });
    await seed({ expiresAt: nowSecs - 200 });
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Sealed }));

    const controller = new AbortController();
    submitSettleMock.mockImplementation(async () => {
      controller.abort();
      return "Sig11111111111111111111111111111111111111111";
    });

    await expect(manager.cleanup({ signal: controller.signal })).rejects.toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
    // The first record's settle completed; the abort is observed before the
    // second one is classified.
    expect(submitSettleMock).toHaveBeenCalledTimes(1);
  });

  it("stop waits for the in-flight pass and does not report the abort as an error", async () => {
    const nowSecs = Math.floor(Date.now() / 1_000);
    await seed({ expiresAt: nowSecs - 200 });
    await seed({ expiresAt: nowSecs - 200 });
    fetchMaybeChannelMock.mockResolvedValue(channelAccount({ status: ChannelStatus.Sealed }));

    let settleFinished = false;
    let releaseSettle: (() => void) | undefined;
    const settleStarted = new Promise<void>(resolve => {
      submitSettleMock.mockImplementation(async () => {
        resolve();
        await new Promise<void>(release => {
          releaseSettle = release;
        });
        settleFinished = true;
        return "Sig11111111111111111111111111111111111111111";
      });
    });

    const onError = vi.fn();
    manager.start({ intervalSecs: 0.01, onError });
    await settleStarted;

    const stopped = manager.stop();
    let stopResolved = false;
    void stopped.then(() => {
      stopResolved = true;
    });

    // stop() must not resolve while a broadcast settle is still outstanding.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(stopResolved).toBe(false);

    releaseSettle?.();
    await stopped;
    expect(settleFinished).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("stop is idempotent and safe when no pass ever ran", async () => {
    await manager.stop();
    await manager.stop();
    expect(submitSettleMock).not.toHaveBeenCalled();
  });

  it("skips channels whose feePayer is not in the signer set", async () => {
    const nowSecs = Math.floor(Date.now() / 1_000);
    const other = await generateKeyPairSigner();
    await seed({ firstSeenAt: Date.now() - 7_200_000, expiresAt: nowSecs - 200 });
    fetchMaybeChannelMock.mockResolvedValue(
      channelAccount({
        status: ChannelStatus.Open,
        payee: other.address,
        rentPayer: other.address,
      }),
    );

    const onError = vi.fn();
    await manager.cleanup({ abandonGraceSecs: 120, onError });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("not in facilitator signer set"),
      }),
      expect.any(Object),
    );
    expect(submitSettleMock).not.toHaveBeenCalled();
  });
});

/**
 * Build a facilitator signer over more than one key. `submitSettle` is
 * mocked in these tests, so `getSigner` need only return a value tied to
 * its `feePayer`, not a real kit signer.
 *
 * @param signers - Underlying kit signers this facilitator manages
 */
function multiKeySigner(
  signers: Awaited<ReturnType<typeof generateKeyPairSigner>>[],
): FacilitatorSvmSigner {
  const byAddress = new Map(signers.map(signer => [signer.address, signer]));
  return {
    getAddresses: () => signers.map(signer => signer.address),
    getSigner: (feePayer: Address) => {
      const signer = byAddress.get(feePayer);
      if (!signer) throw new Error(`no signer for feePayer ${feePayer}`);
      return signer as unknown as TransactionSigner & { signMessages: never };
    },
    getAccountInfo: vi.fn(),
    getLatestBlockhash: vi.fn(),
    getSlot: vi.fn().mockImplementation(() => getSlotMock()),
    getProgramAccounts: vi.fn(),
    signTransaction: vi.fn(),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    confirmTransaction: vi.fn(),
  } as FacilitatorSvmSigner;
}

describe("UptoSvmRentCleanupManager — onchain discovery", () => {
  let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let storage: InMemoryUptoChannelStorage;
  let manager: UptoSvmRentCleanupManager;
  let discoveredChannelId: Address;

  beforeEach(async () => {
    vi.clearAllMocks();
    feePayer = await generateKeyPairSigner();
    payer = await generateKeyPairSigner();
    discoveredChannelId = (await generateKeyPairSigner()).address;
    storage = new InMemoryUptoChannelStorage();
    manager = new UptoSvmRentCleanupManager({
      network: NETWORK,
      signer: toFacilitatorSvmSigner(feePayer),
      storage,
    });
    submitSettleMock.mockResolvedValue("Sig11111111111111111111111111111111111111111");
    getSlotMock.mockResolvedValue(CURRENT_SLOT_READY);
    discoverChannelsMock.mockResolvedValue([]);
  });

  /**
   * @param status - Live channel status discovery should report
   */
  function discovered(status: ChannelStatus) {
    return {
      channel: {
        mint: USDC_DEVNET_ADDRESS,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        payer: payer.address,
        rentPayer: feePayer.address,
        status,
      },
      channelId: discoveredChannelId,
    };
  }

  it("adds an untracked Distributed channel to storage for cleanup to reclaim", async () => {
    discoverChannelsMock.mockResolvedValue([discovered(ChannelStatus.Distributed)]);

    const onDiscover = vi.fn();
    await manager.discover({ onDiscover });

    expect(discoverChannelsMock).toHaveBeenCalledWith(expect.anything(), NETWORK, feePayer.address);
    expect(onDiscover).toHaveBeenCalledWith({ channelIds: [discoveredChannelId] });
    // Only what the chain proves: the Open/Sealed metadata stays empty, which
    // a Distributed channel never needs again.
    expect(await storage.get(discoveredChannelId)).toMatchObject({
      channelId: discoveredChannelId,
      expiresAt: 0,
      network: NETWORK,
      payTo: "",
      tokenProgram: "",
    });
    // Discovery itself never submits: reclaiming is the next cleanup's job.
    expect(submitSettleMock).not.toHaveBeenCalled();
  });

  it("reclaims a discovered channel on the following cleanup pass", async () => {
    discoverChannelsMock.mockResolvedValue([discovered(ChannelStatus.Distributed)]);
    fetchMaybeChannelMock.mockResolvedValue({
      data: {
        mint: USDC_DEVNET_ADDRESS,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        payer: payer.address,
        rentPayer: feePayer.address,
        status: ChannelStatus.Distributed,
      },
      exists: true,
    });

    await manager.discover();
    const onReclaim = vi.fn();
    await manager.cleanup({ onReclaim });

    expect(onReclaim).toHaveBeenCalledWith(
      expect.objectContaining({ channelIds: [discoveredChannelId] }),
    );
  });

  it("ignores discovered channels that are not Distributed", async () => {
    discoverChannelsMock.mockResolvedValue([discovered(ChannelStatus.Open)]);

    const onDiscover = vi.fn();
    await manager.discover({ onDiscover });

    expect(onDiscover).not.toHaveBeenCalled();
    expect(await storage.list()).toHaveLength(0);
  });

  it("ignores discovered channels still inside the open-slot window", async () => {
    discoverChannelsMock.mockResolvedValue([discovered(ChannelStatus.Distributed)]);
    getSlotMock.mockResolvedValue(CURRENT_SLOT_TOO_EARLY);

    await manager.discover();

    expect(await storage.list()).toHaveLength(0);
  });

  // Discovery only knows what the chain proves, so overwriting a settle-time
  // record with a partial one would lose the payTo an abandon-close needs.
  it("never overwrites a channel already tracked in storage", async () => {
    const tracked: UptoChannelRecord = {
      channelId: discoveredChannelId,
      expiresAt: FAR_FUTURE,
      firstSeenAt: Date.now(),
      network: NETWORK,
      payTo: payer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    };
    await storage.upsert(tracked);
    discoverChannelsMock.mockResolvedValue([discovered(ChannelStatus.Distributed)]);

    const onDiscover = vi.fn();
    await manager.discover({ onDiscover });

    expect(onDiscover).not.toHaveBeenCalled();
    expect(await storage.get(discoveredChannelId)).toMatchObject({
      payTo: payer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
  });

  it("reports a sweep failure for one signer and continues", async () => {
    const other = await generateKeyPairSigner();
    manager = new UptoSvmRentCleanupManager({
      network: NETWORK,
      signer: multiKeySigner([feePayer, other]),
      storage,
    });
    discoverChannelsMock
      .mockRejectedValueOnce(new Error("getProgramAccounts failed"))
      .mockResolvedValueOnce([discovered(ChannelStatus.Distributed)]);

    const onError = vi.fn();
    const onDiscover = vi.fn();
    await manager.discover({ onDiscover, onError });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "getProgramAccounts failed" }),
    );
    expect(onDiscover).toHaveBeenCalledWith({ channelIds: [discoveredChannelId] });
  });

  it("runs discovery on its own interval, not the cleanup interval", async () => {
    discoverChannelsMock.mockResolvedValue([]);
    fetchMaybeChannelMock.mockResolvedValue({ exists: false });

    manager.start({ intervalSecs: 0.01, discoveryIntervalSecs: 10 });
    await new Promise(resolve => setTimeout(resolve, 60));
    await manager.stop();

    // Several cleanup ticks elapsed; the daily sweep is not due yet.
    expect(discoverChannelsMock).not.toHaveBeenCalled();
  });

  it("does not sweep at all when no discovery interval is configured", async () => {
    discoverChannelsMock.mockResolvedValue([]);
    fetchMaybeChannelMock.mockResolvedValue({ exists: false });

    manager.start({ intervalSecs: 0.01 });
    await new Promise(resolve => setTimeout(resolve, 60));
    await manager.stop();

    expect(discoverChannelsMock).not.toHaveBeenCalled();
  });
});

describe("UptoSvmRentCleanupManager — concurrent signer groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits independent rent-payer groups concurrently", async () => {
    const feePayerA = await generateKeyPairSigner();
    const feePayerB = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const storage = new InMemoryUptoChannelStorage();
    const manager = new UptoSvmRentCleanupManager({
      network: NETWORK,
      signer: multiKeySigner([feePayerA, feePayerB]),
      storage,
    });

    const recordA = (await generateKeyPairSigner()).address;
    const recordB = (await generateKeyPairSigner()).address;
    await storage.upsert({
      channelId: recordA,
      expiresAt: FAR_FUTURE,
      firstSeenAt: Date.now(),
      network: NETWORK,
      payTo: payTo.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    } as UptoChannelRecord);
    await storage.upsert({
      channelId: recordB,
      expiresAt: FAR_FUTURE,
      firstSeenAt: Date.now(),
      network: NETWORK,
      payTo: payTo.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    } as UptoChannelRecord);

    getSlotMock.mockResolvedValue(CURRENT_SLOT_READY);
    fetchMaybeChannelMock.mockImplementation((_rpc: unknown, channelId: string) => {
      const rentPayer = channelId === recordA ? feePayerA.address : feePayerB.address;
      return Promise.resolve({
        data: {
          mint: USDC_DEVNET_ADDRESS,
          openSlot: OPEN_SLOT,
          payee: rentPayer,
          payer: payer.address,
          rentPayer,
          status: ChannelStatus.Distributed,
        },
        exists: true,
      });
    });

    let entered = 0;
    let sawConcurrentEntry = false;
    const releasers: (() => void)[] = [];
    submitSettleMock.mockImplementation(
      () =>
        new Promise(resolve => {
          entered += 1;
          if (entered > 1) sawConcurrentEntry = true;
          releasers.push(() => resolve("Sig11111111111111111111111111111111111111111"));
        }),
    );

    const pass = manager.cleanup({});
    // Let both groups reach submitSettle before releasing either.
    await vi.waitFor(() => expect(releasers).toHaveLength(2));
    releasers.forEach(release => release());
    await pass;

    expect(sawConcurrentEntry).toBe(true);
    expect(submitSettleMock).toHaveBeenCalledTimes(2);
  });

  it("budgets each rent-payer group independently instead of sharing a pool", async () => {
    const feePayerA = await generateKeyPairSigner();
    const feePayerB = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const storage = new InMemoryUptoChannelStorage();
    const manager = new UptoSvmRentCleanupManager({
      network: NETWORK,
      signer: multiKeySigner([feePayerA, feePayerB]),
      storage,
    });

    const channelIds: string[] = [];
    for (let group = 0; group < 2; group++) {
      for (let i = 0; i < 3; i++) {
        const channel = await generateKeyPairSigner();
        await storage.upsert({
          channelId: channel.address,
          expiresAt: FAR_FUTURE,
          firstSeenAt: Date.now(),
          network: NETWORK,
          payTo: payTo.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        } as UptoChannelRecord);
        channelIds.push(channel.address);
      }
    }
    const rentPayerFor = new Map<string, string>([
      [channelIds[0]!, feePayerA.address],
      [channelIds[1]!, feePayerA.address],
      [channelIds[2]!, feePayerA.address],
      [channelIds[3]!, feePayerB.address],
      [channelIds[4]!, feePayerB.address],
      [channelIds[5]!, feePayerB.address],
    ]);

    getSlotMock.mockResolvedValue(CURRENT_SLOT_READY);
    fetchMaybeChannelMock.mockImplementation((_rpc: unknown, channelId: string) => {
      const rentPayer = rentPayerFor.get(channelId)!;
      return Promise.resolve({
        data: {
          mint: USDC_DEVNET_ADDRESS,
          openSlot: OPEN_SLOT,
          payee: rentPayer,
          payer: payer.address,
          rentPayer,
          status: ChannelStatus.Distributed,
        },
        exists: true,
      });
    });
    submitSettleMock.mockResolvedValue("Sig11111111111111111111111111111111111111111");

    const onReclaim = vi.fn();
    await manager.cleanup({ maxReclaimsPerTx: 1, maxTxsPerSigner: 2, onReclaim });

    // Each of the two rent-payer groups gets its own budget of 2, not a
    // shared pool of 2 total.
    expect(onReclaim).toHaveBeenCalledTimes(4);
  });
});
