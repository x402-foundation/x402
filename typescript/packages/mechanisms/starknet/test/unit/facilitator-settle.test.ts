import { describe, it, expect, vi, beforeEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hash, RpcError, type RpcProvider } from "starknet";
import { feltEquals } from "../../src/utils";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactStarknetScheme } from "../../src/exact/facilitator/scheme";
import {
  toFacilitatorStarknetPaymasterSigner,
  type FacilitatorStarknetSigner,
} from "../../src/signer";
import {
  buildCanonicalOutsideExecutionTypedData,
  type OutsideExecutionMessage,
} from "../../src/typed-data";
import { SettlementCache, nonceKey } from "../../src/settlement-cache";
import {
  ANY_CALLER,
  STARKNET_ERROR_REASONS,
  STARKNET_SEPOLIA_CAIP2,
  VALID_SIGNATURE_MAGIC,
} from "../../src/constants";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FROM = "0x03f16efeb2ae57f7d8befb03af08a3a370562dde15149c3506ac2038ffa9be24";
const PAY_TO = "0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57";
const ASSET = "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343";
// The facilitator-managed feePayer: the required SNIP-9 Caller (merged-spec model).
const FEE_PAYER = "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81";
const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
const TRANSFER_SELECTOR = hash.getSelectorFromName("transfer");
const TRANSFER_EVENT_KEY = hash.getSelectorFromName("Transfer");
const EXECUTE_FROM_OUTSIDE_V2 = hash.getSelectorFromName("execute_from_outside_v2");

// Core (non-Starknet-specific) reason tokens asserted here are bare enum tokens.
const INVALID_TRANSACTION_STATE = "invalid_transaction_state";

// Deterministic clock used only where fake timers are required.
const NOW_SEC = 1_800_000_000;
const NOW_MS = NOW_SEC * 1000;

/** Current epoch seconds - real time, or the fake clock under vi.useFakeTimers. */
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function buildRequirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: STARKNET_SEPOLIA_CAIP2,
    amount: "10000",
    payTo: PAY_TO,
    asset: ASSET,
    maxTimeoutSeconds: 300,
    extra: { feePayer: FEE_PAYER },
  };
}

function buildMessage(nonce: string): OutsideExecutionMessage {
  return {
    Caller: FEE_PAYER,
    Nonce: nonce,
    "Execute After": String(nowSec() - 100),
    "Execute Before": String(nowSec() + 300),
    Calls: [{ To: ASSET, Selector: TRANSFER_SELECTOR, Calldata: [PAY_TO, "0x2710", "0x0"] }],
  };
}

function buildPayload(accepted: PaymentRequirements, nonce: string): PaymentPayload {
  const typedData = buildCanonicalOutsideExecutionTypedData(SEPOLIA_CHAIN_ID, buildMessage(nonce));
  return {
    x402Version: 2,
    accepted,
    payload: {
      from: FROM,
      outsideExecution: { typedData, signature: ["0x1a2b", "0x3c4d"] },
    },
  };
}

// ---------------------------------------------------------------------------
// Mock provider + signer
// ---------------------------------------------------------------------------

/** Cairo-1 keyed asset Transfer (payer → payTo, 10000) for traces and receipts. */
const assetTransfer = () => ({
  from_address: ASSET,
  keys: [TRANSFER_EVENT_KEY, FROM, PAY_TO],
  data: ["0x2710", "0x0"],
});

/** Trace frame for `execute_from_outside_v2` on `on`, calldata `[caller, nonce, ...]`. */
const efoFrame = (nonce: string, opts?: { caller?: string; on?: string }) => ({
  contract_address: opts?.on ?? FROM,
  entry_point_selector: EXECUTE_FROM_OUTSIDE_V2,
  calldata: [opts?.caller ?? FEE_PAYER, nonce, "0x1", "0x7fffffff", "0x1"],
  calls: [],
});

/** Direct-executor topology: the relayer account's multicall wraps the payer call. */
const consumingTrace = (nonce: string, opts?: { caller?: string; on?: string }) => ({
  execute_invocation: {
    contract_address: "0x0e1a4e5",
    calldata: [],
    calls: [efoFrame(nonce, opts)],
  },
});

/** Paymaster topology: relayer -> forwarder contract -> payer. */
const forwardedTrace = (nonce: string) => ({
  execute_invocation: {
    contract_address: "0x0e1a4e5",
    calls: [{ contract_address: FEE_PAYER, calldata: [], calls: [efoFrame(nonce)] }],
  },
});

/** A transaction that only moved tokens - no execute_from_outside_v2 frame anywhere. */
const transferOnlyTrace = () => ({
  execute_invocation: {
    contract_address: FROM,
    calls: [
      {
        contract_address: ASSET,
        entry_point_selector: TRANSFER_SELECTOR,
        calldata: [PAY_TO, "0x2710", "0x0"],
        calls: [],
      },
    ],
  },
});

const successfulTrace = () => [
  {
    transaction_trace: {
      execute_invocation: { revert_reason: undefined, events: [assetTransfer()], calls: [] },
    },
  },
];

interface MockOpts {
  /** is_valid_signature return felt (defaults to the VALID magic). */
  sig?: string;
  /** When true, is_valid_outside_execution_nonce reports the nonce as consumed. */
  nonceUsed?: boolean;
  /** When true, getClassHashAt throws to simulate a non-deployed account. */
  notDeployed?: boolean;
  /** When set, getEvents returns a landed asset Transfer bound to this tx hash. */
  landedTx?: string;
  /** Overrides the shape of the landed event (layout / emitter / amount tests). */
  landedEvent?: Record<string, unknown>;
  /** getTransactionTrace result (authorization-identity check during the rescue). */
  txTrace?: unknown;
  /** Receipt execution_status (defaults to SUCCEEDED). */
  receiptStatus?: string;
  /** Receipt events (defaults to the exact asset Transfer). */
  receiptEvents?: unknown[];
  /** When true, getTransactionReceipt throws on every attempt (indeterminate). */
  receiptThrows?: boolean;
  /** Receipt finality_status (defaults to ACCEPTED_ON_L2). */
  finalityStatus?: string;
  /** Receipt block_number; pass null to model a pending-block receipt. */
  blockNumber?: number | null;
  /** Head block number reported by the provider. */
  headBlock?: number;
  /** Observed seconds per block; omit to model a provider without timestamps. */
  secondsPerBlock?: number;
  /** Full control over getEvents paging, for scan-budget tests. */
  eventPages?: (filter: { keys?: string[][] }) => {
    events: Record<string, unknown>[];
    continuation_token?: string;
  };
}

/**
 * A real Starknet node rejects a read with no block id ("Invalid block id"),
 * because starknet.js's default `pending` tag no longer exists in RPC 0.9+.
 * Modelling that here is what makes a lost READ_BLOCK pin fail a test.
 *
 * @param block - The block identifier the call was made with
 */
function requirePinned(block: string | undefined): void {
  if (!block) throw new Error("Invalid block id: read was not pinned");
}

/** Records the event filters a scan issued, so tests can assert both passes ran. */
const eventQueries: {
  address?: string;
  keys?: string[][];
  from_block?: { block_number: number };
}[] = [];

// Module-scoped: without a reset, one test's queries satisfy another's
// assertion and the check passes for the wrong reason.
beforeEach(() => {
  eventQueries.length = 0;
});

function mockProvider(o: MockOpts = {}): RpcProvider {
  return {
    async getClassHashAt(_address: string, block?: string) {
      requirePinned(block);
      // A real node reports this as a STRUCTURED RpcError (code 20), which is
      // what the verify path now requires before blaming the account.
      if (o.notDeployed) throw new RpcError({ code: 20, message: "contract not found" } as never);
      return "0x123";
    },
    async callContract({ entrypoint }: { entrypoint: string }, block?: string) {
      requirePinned(block);
      if (entrypoint === "is_valid_signature") return [o.sig ?? VALID_SIGNATURE_MAGIC];
      if (entrypoint === "is_valid_outside_execution_nonce") return [o.nonceUsed ? "0x0" : "0x1"];
      if (entrypoint === "balanceOf" || entrypoint === "balance_of") return ["0x2710", "0x0"];
      throw new Error(`unexpected entrypoint ${entrypoint}`);
    },
    async getContractVersion(
      _address: string,
      classHash?: undefined,
      options?: { blockIdentifier?: string },
    ) {
      // A real node rejects an unpinned read ("Invalid block id"), and the block
      // id is the THIRD argument - passing it second lands in `classHash` and is
      // silently ignored. Model that here so the mock cannot hide it.
      if (classHash !== undefined) throw new Error("block id passed in the classHash slot");
      if (!options?.blockIdentifier) throw new Error("Invalid block id: read was not pinned");
      return { cairo: "1" };
    },
    async getNonceForAddress(_address: string, block?: string) {
      requirePinned(block);
      return "0x5";
    },
    async getSimulateTransaction(_inv: unknown[], opts?: { blockIdentifier?: string }) {
      requirePinned(opts?.blockIdentifier);
      return successfulTrace();
    },
    async getBlockNumber() {
      return o.headBlock ?? 1000;
    },
    async getBlockWithTxHashes(blockNumber: number) {
      // Model a chain whose observed pace is `secondsPerBlock`. Absent, the
      // provider has no timestamps and the scan falls back to its fixed window.
      if (o.secondsPerBlock === undefined) throw new Error("not supported");
      return { block_number: blockNumber, timestamp: blockNumber * o.secondsPerBlock };
    },
    async getEvents(filter: {
      address?: string;
      keys?: string[][];
      from_block?: { block_number: number };
    }) {
      eventQueries.push(filter);
      if (o.eventPages) return o.eventPages(filter);
      if (!o.landedTx) return { events: [], continuation_token: undefined };
      const event = o.landedEvent ?? assetTransfer();
      // Apply the filter the way a real node does: by emitting contract, and by
      // positional key VALUES. A mock that ignored these would still return the
      // planted event after the scan filter was corrupted, hiding the bug.
      if (filter.address && !feltEquals(filter.address, event.from_address as string)) {
        return { events: [], continuation_token: undefined };
      }
      const keys = (event.keys as string[] | undefined) ?? [];
      const matches = (filter.keys ?? []).every(
        (allowed, i) => keys[i] !== undefined && allowed.some(k => feltEquals(k, keys[i])),
      );
      if (!matches) return { events: [], continuation_token: undefined };
      return {
        events: [{ ...event, transaction_hash: o.landedTx }],
        continuation_token: undefined,
      };
    },
    async getTransactionTrace() {
      // No frames by default: a rescue-success test must supply the real trace.
      return o.txTrace ?? { execute_invocation: { calls: [] } };
    },
    async waitForTransaction() {
      return {};
    },
    async getTransactionReceipt() {
      if (o.receiptThrows) throw new Error("rpc down");
      return {
        execution_status: o.receiptStatus ?? "SUCCEEDED",
        finality_status: o.finalityStatus ?? "ACCEPTED_ON_L2",
        block_number: o.blockNumber === undefined ? 1000 : o.blockNumber,
        events: o.receiptEvents ?? [assetTransfer()],
      };
    },
  } as unknown as RpcProvider;
}

function makeSigner(transactionHash = "0xabc"): FacilitatorStarknetSigner {
  return {
    getAddresses: () => [FEE_PAYER],
    executeFromOutside: async () => ({ transactionHash }),
  };
}

function makeFacilitator(opts: MockOpts, transactionHash?: string): ExactStarknetScheme {
  return new ExactStarknetScheme(makeSigner(transactionHash), {
    providerFactory: () => mockProvider(opts),
  });
}

/**
 * A single facilitator instance whose mocked chain state can change between
 * calls. The settlement guards are scoped to the instance, so any test about
 * one settlement influencing the next MUST drive one facilitator rather than
 * constructing a fresh one per call.
 *
 * @returns The facilitator and a setter for the next call's chain state
 */
function makeStatefulFacilitator(): {
  facilitator: ExactStarknetScheme;
  next: (opts: MockOpts, transactionHash?: string) => void;
} {
  let opts: MockOpts = {};
  let txHash = "0xabc";
  const signer: FacilitatorStarknetSigner = {
    getAddresses: () => [FEE_PAYER],
    executeFromOutside: async () => ({ transactionHash: txHash }),
  };
  const facilitator = new ExactStarknetScheme(signer, {
    providerFactory: () => mockProvider(opts),
  });
  return {
    facilitator,
    next: (o, t) => {
      opts = o;
      if (t !== undefined) txHash = t;
    },
  };
}

// ---------------------------------------------------------------------------
// settle() - broadcast + confirmation state machine
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.settle() - broadcast and confirmation", () => {
  it("broadcasts via the signer and confirms a SUCCEEDED transfer", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e001");
    const facilitator = makeFacilitator({}, "0xabc");

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0xabc");
    expect(result.amount).toBe("10000");
    expect(result.payer).toBe(FROM);
    expect(result.network).toBe(STARKNET_SEPOLIA_CAIP2);
    expect(result.errorReason).toBeUndefined();
  });

  it("short-circuits to failure when settlement re-verification fails (never broadcasts)", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e002");
    // An invalid onchain signature makes re-verification reject with a bare token.
    const facilitator = makeFacilitator({ sig: "0x0" }, "0x05b0adca57");

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.INVALID_SIGNATURE);
    // A pre-broadcast rejection never carries a settlement tx hash.
    expect(result.transaction).toBe("");
  });

  // Spec Duplicate Settlement Mitigation, step 1: while the guard holds - even
  // after the settlement SUCCEEDED - every repeat is duplicate_settlement.
  // Answering success for a repeat inside the guard window would let one
  // payment release the resource N times (the exact vulnerability the XRPL
  // reference PR was required to patch).
  // The early guard short-circuits BEFORE any onchain read, and omits `payer`:
  // at that point the address is only the client's unverified claim (spec rule
  // 9). The later pre-broadcast guard runs after verification and does echo it,
  // so the absent payer is what distinguishes the two.
  it("rejects a duplicate before doing any onchain work, without echoing an unverified payer", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e00f");
    let reads = 0;
    const signer: FacilitatorStarknetSigner = {
      getAddresses: () => [FEE_PAYER],
      executeFromOutside: async () => ({ transactionHash: "0x0f1005701" }),
    };
    const base = mockProvider({});
    const counting = new Proxy(base as object, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v === "function") {
          return (...args: unknown[]) => {
            reads += 1;
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return v;
      },
    }) as RpcProvider;
    const facilitator = new ExactStarknetScheme(signer, { providerFactory: () => counting });

    const first = await facilitator.settle(payload, requirements);
    expect(first.success).toBe(true);

    reads = 0;
    const dup = await facilitator.settle(payload, requirements);
    expect(dup.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
    expect(dup.payer).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("rejects a repeat inside the guard window even after a successful settlement", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e003");
    const { facilitator, next } = makeStatefulFacilitator();

    next({}, "0x0f1005701");
    const first = await facilitator.settle(payload, requirements);
    expect(first.success).toBe(true);

    const replay = await facilitator.settle(payload, requirements);
    expect(replay.success).toBe(false);
    expect(replay.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
  });

  // Spec step 5: AFTER the guard is evicted, a legitimate retry (a caller that
  // lost the success response) resolves idempotently - through the
  // AUTHENTICATED rescue path, never from the cache alone, because
  // (payer, nonce) is public onchain data anyone could name.
  it("resolves a post-eviction retry idempotently via the authenticated rescue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const nonce = "0x5711e00d";
      const payload = buildPayload(requirements, nonce); // Execute Before = NOW + 300
      const { facilitator, next } = makeStatefulFacilitator();

      next({}, "0x0f1005703");
      const first = await facilitator.settle(payload, requirements);
      expect(first.success).toBe(true);

      // Past Execute Before + skew: the guard is evicted; the retry re-verifies,
      // fails on the consumed nonce, and the rescue re-authenticates the payload
      // before resolving to the landed transaction.
      vi.setSystemTime(NOW_MS + 400_000);
      next({
        nonceUsed: true,
        landedTx: "0x0f1005703",
        txTrace: consumingTrace(nonce),
      });
      const retry = await facilitator.settle(payload, requirements);
      expect(retry.success).toBe(true);
      expect(retry.transaction).toBe(first.transaction);
    } finally {
      vi.useRealTimers();
    }
  });

  // A forged payload naming a settled (payer, nonce) gets nothing from either
  // phase: duplicate_settlement inside the guard window, and after eviction
  // re-verification's onchain signature check rejects it before any rescue -
  // no cache entry may ever vouch for a payload the account did not sign.
  it("never resolves a repeat for a payload whose signature does not validate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const nonce = "0x5711e00c";
      const { facilitator, next } = makeStatefulFacilitator();

      next({}, "0x0f1005702");
      const first = await facilitator.settle(buildPayload(requirements, nonce), requirements);
      expect(first.success).toBe(true);

      // Inside the guard window: duplicate, regardless of payload contents.
      const inside = await facilitator.settle(buildPayload(requirements, nonce), requirements);
      expect(inside.success).toBe(false);
      expect(inside.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);

      // After eviction: same (payer, nonce), garbage signature -
      // re-verification's onchain signature check rejects it, so the landed
      // transfer is never attributed to the forger.
      vi.setSystemTime(NOW_MS + 400_000);
      next({
        sig: "0x0",
        nonceUsed: true,
        landedTx: "0x0f1005702",
        txTrace: consumingTrace(nonce),
      });
      const forged = await facilitator.settle(buildPayload(requirements, nonce), requirements);
      expect(forged.success).toBe(false);
      expect(forged.transaction).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  // The race the early guard alone cannot catch: a concurrent straggler passes
  // the entry gate BEFORE the winner holds the guard, then completes its
  // re-verification AFTER the winner's broadcast consumed the nonce. Its
  // NONCE_ALREADY_USED rejection routes into the rescue branch, which would
  // resolve the winner's own settlement as a second success - one payment,
  // two resource releases - unless the rescue re-checks the guard.
  it("a concurrent straggler that sees the consumed nonce cannot rescue the winner's settlement", async () => {
    const requirements = buildRequirements();
    const nonce = "0x5711e00e";
    const payload = buildPayload(requirements, nonce);

    let nonceCalls = 0;
    let releaseStragglerNonce: (value: string[]) => void = () => {};
    const stragglerNonce = new Promise<string[]>(resolve => {
      releaseStragglerNonce = resolve;
    });
    let releaseBroadcast: (value: { transactionHash: string }) => void = () => {};
    let broadcasts = 0;

    const provider = {
      async getClassHashAt() {
        return "0x123";
      },
      async callContract({ entrypoint }: { entrypoint: string }, block?: string) {
        requirePinned(block);
        if (entrypoint === "is_valid_signature") return [VALID_SIGNATURE_MAGIC];
        if (entrypoint === "is_valid_outside_execution_nonce") {
          nonceCalls += 1;
          // Winner reads first and sees the nonce unused; the straggler's read
          // is parked until the winner has held the guard and broadcast.
          if (nonceCalls === 1) return ["0x1"];
          return stragglerNonce;
        }
        if (entrypoint === "balanceOf" || entrypoint === "balance_of") return ["0x2710", "0x0"];
        throw new Error(`unexpected entrypoint ${entrypoint}`);
      },
      async getContractVersion(
        _address: string,
        classHash?: undefined,
        options?: { blockIdentifier?: string },
      ) {
        // A real node rejects an unpinned read ("Invalid block id"), and the block
        // id is the THIRD argument - passing it second lands in `classHash` and is
        // silently ignored. Model that here so the mock cannot hide it.
        if (classHash !== undefined) throw new Error("block id passed in the classHash slot");
        if (!options?.blockIdentifier) throw new Error("Invalid block id: read was not pinned");
        return { cairo: "1" };
      },
      async getNonceForAddress() {
        return "0x5";
      },
      async getSimulateTransaction() {
        return successfulTrace();
      },
      async getBlockNumber() {
        return 1000;
      },
      async getEvents() {
        return {
          events: [{ ...assetTransfer(), transaction_hash: "0x0bede1a7" }],
          continuation_token: undefined,
        };
      },
      async getTransactionTrace() {
        // Real consuming-transaction trace: without it the identity check
        // rejects regardless, and the test could not demonstrate the
        // double-success it exists to prevent.
        return consumingTrace(nonce);
      },
      async waitForTransaction() {
        return {};
      },
      async getTransactionReceipt() {
        return {
          execution_status: "SUCCEEDED",
          finality_status: "ACCEPTED_ON_L2",
          block_number: 1000,
          events: [assetTransfer()],
        };
      },
    } as unknown as RpcProvider;

    const signer: FacilitatorStarknetSigner = {
      getAddresses: () => [FEE_PAYER],
      executeFromOutside: () => {
        broadcasts += 1;
        // The guard is held by the time the broadcast is invoked. Only now may
        // the straggler observe the consumed nonce.
        releaseStragglerNonce(["0x0"]);
        return new Promise(resolve => {
          releaseBroadcast = resolve;
        });
      },
    };
    const facilitator = new ExactStarknetScheme(signer, { providerFactory: () => provider });

    const winner = facilitator.settle(payload, requirements);
    const straggler = facilitator.settle(payload, requirements);

    const stragglerResult = await straggler;
    expect(stragglerResult.success).toBe(false);
    expect(stragglerResult.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);

    releaseBroadcast({ transactionHash: "0x0bede1a7" });
    const winnerResult = await winner;
    expect(winnerResult.success).toBe(true);
    expect(broadcasts).toBe(1);
  });

  // Settlement step 4: while the outcome is UNRESOLVED the facilitator MUST NOT
  // re-broadcast and MUST answer a repeat request with duplicate_settlement.
  it("rejects a repeat request while the outcome is unresolved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e00b");
      let broadcasts = 0;
      const signer: FacilitatorStarknetSigner = {
        getAddresses: () => [FEE_PAYER],
        executeFromOutside: async () => {
          broadcasts += 1;
          return { transactionHash: "0x0bede1a6" };
        },
      };
      const facilitator = new ExactStarknetScheme(signer, {
        providerFactory: () => mockProvider({ receiptThrows: true }),
      });

      const pending = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      const first = await pending;
      expect(first.errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);

      const repeat = await facilitator.settle(payload, requirements);
      expect(repeat.success).toBe(false);
      expect(repeat.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
      // The unresolved authorization must never be broadcast a second time.
      expect(broadcasts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Nothing may outlive the confirmation deadline: a poller still querying the
  // node after the settlement has resolved would run for the life of the
  // process - under requireL1Finality, where L1 acceptance takes hours, on
  // every settlement.
  it("stops polling once the confirmation deadline passes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e00c");
      let receiptReads = 0;
      let sdkPollerStarted = 0;
      const signer: FacilitatorStarknetSigner = {
        getAddresses: () => [FEE_PAYER],
        executeFromOutside: async () => ({ transactionHash: "0x0bede1a7" }),
      };
      const facilitator = new ExactStarknetScheme(signer, {
        providerFactory: () => {
          const provider = mockProvider({}) as unknown as {
            getTransactionReceipt: () => Promise<unknown>;
            waitForTransaction: () => Promise<unknown>;
          };
          // Permanently pending: SUCCEEDED but never in a block.
          provider.getTransactionReceipt = async () => {
            receiptReads += 1;
            return { execution_status: "SUCCEEDED", finality_status: "RECEIVED" };
          };
          // The SDK poller cannot be cancelled once started, so the fix is that
          // it is never started - not merely that we stop awaiting it.
          provider.waitForTransaction = async () => {
            sdkPollerStarted += 1;
            return new Promise(() => {});
          };
          return provider as unknown as RpcProvider;
        },
        requireL1Finality: true,
      });

      const pending = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);
      expect(result.transaction).toBe("0x0bede1a7");
      expect(sdkPollerStarted).toBe(0);
      // Polling must have actually retried across the window, not given up once.
      expect(receiptReads).toBeGreaterThan(1);

      const readsAtDeadline = receiptReads;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(receiptReads).toBe(readsAtDeadline);
    } finally {
      vi.useRealTimers();
    }
  });

  // Spec Timeout Mapping: the verify-time freshness band (the authorization must
  // still cover the full advertised window) is not re-applied at settlement,
  // where only the minimum remaining window matters - a settlement arriving late
  // in the window must not fail a check the payment already passed.
  it("does not re-apply the verify-time freshness band at settlement", async () => {
    const requirements = buildRequirements();
    const message = { ...buildMessage("0x5711e013"), "Execute Before": String(nowSec() + 100) };
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: {
        from: FROM,
        outsideExecution: {
          typedData: buildCanonicalOutsideExecutionTypedData(SEPOLIA_CHAIN_ID, message),
          signature: ["0x1a2b", "0x3c4d"],
        },
      },
    };
    const facilitator = makeFacilitator({}, "0x0f2e5e");

    const verified = await facilitator.verify(payload, requirements);
    expect(verified.invalidReason).toBe(STARKNET_ERROR_REASONS.EXPIRED);

    const settled = await facilitator.settle(payload, requirements);
    expect(settled.success).toBe(true);
    expect(settled.transaction).toBe("0x0f2e5e");
  });

  it("fails a REVERTED settlement with invalid_transaction_state and releases the guard for retry", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e004");
    const facilitator = makeFacilitator({ receiptStatus: "REVERTED" }, "0x0e5e7a1");

    const first = await facilitator.settle(payload, requirements);
    expect(first.success).toBe(false);
    expect(first.errorReason).toBe(INVALID_TRANSACTION_STATE);
    // A transaction was broadcast, so its hash is reported for inspection.
    expect(first.transaction).toBe("0x0e5e7a1");

    // A revert rolls back the SNIP-9 nonce onchain, so the guard is released and
    // a retry is NOT rejected as a duplicate (it simply reverts again).
    const second = await facilitator.settle(payload, requirements);
    expect(second.success).toBe(false);
    expect(second.errorReason).toBe(INVALID_TRANSACTION_STATE);
    expect(second.errorReason).not.toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
  });

  it("fails a SUCCEEDED settlement whose receipt lacks the expected transfer (effect mismatch)", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e005");
    // SUCCEEDED execution but no matching payer → payTo Transfer in the receipt.
    const facilitator = makeFacilitator({ receiptEvents: [] }, "0x00effec70");

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(INVALID_TRANSACTION_STATE);
    expect(result.transaction).toBe("0x00effec70");
  });

  // Settlement step 6: RPC acceptance or pending status is never sufficient to
  // release the resource. A SUCCEEDED execution_status on a receipt that is not
  // yet IN A BLOCK describes a transaction that can still be dropped.
  it("refuses to report success for a SUCCEEDED receipt that is not yet in a block", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e010");
      const facilitator = makeFacilitator(
        { receiptStatus: "SUCCEEDED", finalityStatus: "RECEIVED", blockNumber: null },
        "0x0bede1a8",
      );

      const promise = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);
      // Non-terminal: the hash survives so the caller can reconcile onchain.
      expect(result.transaction).toBe("0x0bede1a8");
    } finally {
      vi.useRealTimers();
    }
  });

  // A REVERTED status on a receipt that is not yet in a block is equally not an
  // outcome: the guard stays held and the hash is reported for reconciliation,
  // rather than releasing the authorization for an immediate re-broadcast.
  it("keeps a pre-confirmed REVERTED receipt unresolved until it is in a block", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e012");
      const facilitator = makeFacilitator(
        { receiptStatus: "REVERTED", finalityStatus: "PRE_CONFIRMED", blockNumber: null },
        "0x0bede1ac",
      );

      const promise = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);
      expect(result.transaction).toBe("0x0bede1ac");

      const repeat = await facilitator.settle(payload, requirements);
      expect(repeat.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
    } finally {
      vi.useRealTimers();
    }
  });

  // requireL1Finality must actually raise the bar: an ACCEPTED_ON_L2 receipt is
  // not settled for a facilitator configured to demand L1.
  it("refuses an L2-only receipt when requireL1Finality is set", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e011");
      const facilitator = new ExactStarknetScheme(makeSigner("0x0bede1a9"), {
        providerFactory: () => mockProvider({ finalityStatus: "ACCEPTED_ON_L2" }),
        requireL1Finality: true,
      });

      const promise = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns non-terminal settlement_pending (with the tx hash) when confirmation is indeterminate", async () => {
    // confirmExecution sleeps between receipt retries; drive it with fake timers.
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e006");
      const facilitator = makeFacilitator({ receiptThrows: true }, "0x0bede1a6");

      const promise = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);
      // The tx hash is preserved on the non-terminal path for onchain reconciliation.
      expect(result.transaction).toBe("0x0bede1a6");
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the guard and allows retry when the broadcast itself throws", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e007");
    let attempts = 0;
    const signer: FacilitatorStarknetSigner = {
      getAddresses: () => [FEE_PAYER],
      executeFromOutside: async () => {
        attempts += 1;
        throw new Error("paymaster refused: secret-key-in-url");
      },
    };
    const facilitator = new ExactStarknetScheme(signer, {
      providerFactory: () => mockProvider({}),
    });

    const first = await facilitator.settle(payload, requirements);
    expect(first.success).toBe(false);
    expect(first.errorReason).toBe("unexpected_settle_error");
    // Raw executor internals must never reach the wire.
    expect(first.errorMessage).not.toContain("secret-key-in-url");

    // A definitive broadcast failure consumed nothing onchain, so the guard is
    // released and the same authorization may be retried.
    const second = await facilitator.settle(payload, requirements);
    expect(second.errorReason).not.toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
    expect(attempts).toBe(2);
  });

  it("releases the guard when the executor returns no transaction hash", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e008");
    const signer: FacilitatorStarknetSigner = {
      getAddresses: () => [FEE_PAYER],
      executeFromOutside: async () => ({ transactionHash: "" }),
    };
    const facilitator = new ExactStarknetScheme(signer, {
      providerFactory: () => mockProvider({}),
    });

    const first = await facilitator.settle(payload, requirements);
    expect(first.success).toBe(false);
    expect(first.errorReason).toBe("unexpected_settle_error");

    const second = await facilitator.settle(payload, requirements);
    expect(second.errorReason).not.toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
  });

  // A timeout says nothing about whether the paymaster received the request, so
  // the transaction may still land. Releasing the guard would let the very next
  // retry broadcast the same authorization a second time. No hash exists to
  // reconcile, and `settlement_pending` MUST carry one (x402 v2 §9), so the
  // wire code is the standard settle error while the guard does the protecting.
  // Driven through a REAL paymaster signer whose transport times out, not a
  // hand-thrown error object. starknet's transports rethrow only `LibraryError`
  // and rewrap everything else as a plain `Error`, so a test that fabricates the
  // rejection proves nothing about the shape production actually sees.
  it("holds the guard when the broadcast times out", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e00d");
    let requests = 0;

    // Accepts the connection and never answers - what the per-request timeout
    // exists to bound. A refused port would be a connection error instead.
    const server = createServer(() => {});
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const signer = toFacilitatorStarknetPaymasterSigner({
        feePayerAddresses: [FEE_PAYER],
        paymasterUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 50,
      });
      const facilitator = new ExactStarknetScheme(
        {
          ...signer,
          executeFromOutside: (params, network) => {
            requests += 1;
            return signer.executeFromOutside(params, network);
          },
        },
        { providerFactory: () => mockProvider({}) },
      );

      const first = await facilitator.settle(payload, requirements);
      expect(first.success).toBe(false);
      expect(first.errorReason).toBe("unexpected_settle_error");
      expect(first.transaction).toBe("");

      const second = await facilitator.settle(payload, requirements);
      expect(second.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
      expect(requests).toBe(1);
    } finally {
      server.close();
    }
  });

  // The budget covers the response body, not just the headers: a paymaster that
  // answers 200 and then stalls the JSON body has equally left the outcome
  // unknown, and starknet.js reads that body outside any fetch-level catch.
  it("holds the guard when the broadcast response body stalls past the timeout", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e014");
    let requests = 0;

    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"jsonrpc":"2.0","id":1,"result":');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const signer = toFacilitatorStarknetPaymasterSigner({
        feePayerAddresses: [FEE_PAYER],
        paymasterUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 50,
      });
      const facilitator = new ExactStarknetScheme(
        {
          ...signer,
          executeFromOutside: (params, network) => {
            requests += 1;
            return signer.executeFromOutside(params, network);
          },
        },
        { providerFactory: () => mockProvider({}) },
      );

      const first = await facilitator.settle(payload, requirements);
      expect(first.success).toBe(false);
      expect(first.errorReason).toBe("unexpected_settle_error");

      const second = await facilitator.settle(payload, requirements);
      expect(second.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  // The signer may be third-party infrastructure (a SNIP-29 paymaster), so what
  // it hands back is untrusted input. Unchecked, it reaches RPC reads, the
  // server log, and the wire `transaction` field, and burns the confirmation
  // deadline while the duplicate guard is held.
  // A hash past the field prime is no more a real hash than a non-felt string;
  // the field-range conjunct is what rejects it, and a broken signer must not
  // burn the confirmation deadline holding the guard on one.
  it("rejects an out-of-field transaction hash, and releases the guard", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e00e");
    const signer: FacilitatorStarknetSigner = {
      getAddresses: () => [FEE_PAYER],
      executeFromOutside: async () => ({ transactionHash: "0x" + "f".repeat(64) }),
    };
    const facilitator = new ExactStarknetScheme(signer, {
      providerFactory: () => mockProvider({}),
    });

    const first = await facilitator.settle(payload, requirements);
    expect(first.success).toBe(false);
    expect(first.errorReason).toBe("unexpected_settle_error");
    expect(first.transaction).toBe("");

    const second = await facilitator.settle(payload, requirements);
    expect(second.errorReason).not.toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
  });

  it("rejects a transaction hash that is not a felt, and releases the guard", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e009");
    let receiptReads = 0;
    const signer: FacilitatorStarknetSigner = {
      getAddresses: () => [FEE_PAYER],
      executeFromOutside: async () => ({ transactionHash: "0xabc[2K forged" }),
    };
    const facilitator = new ExactStarknetScheme(signer, {
      providerFactory: () => {
        const provider = mockProvider({}) as unknown as {
          getTransactionReceipt: (h: string) => Promise<unknown>;
        };
        const inner = provider.getTransactionReceipt.bind(provider);
        provider.getTransactionReceipt = async (h: string) => {
          receiptReads += 1;
          return inner(h);
        };
        return provider as unknown as RpcProvider;
      },
    });

    const first = await facilitator.settle(payload, requirements);
    expect(first.success).toBe(false);
    expect(first.errorReason).toBe("unexpected_settle_error");
    expect(first.transaction).toBe("");
    expect(receiptReads).toBe(0);

    const second = await facilitator.settle(payload, requirements);
    expect(second.errorReason).not.toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
  });
});

// ---------------------------------------------------------------------------
// settle() - consumed-nonce rescue (spec settlement step 5)
//
// SECURITY. This path reports success for a payment this facilitator did not
// broadcast, so everything it trusts must be independently re-established:
// the payload's signature, that the nonce is really consumed, that the naming
// transaction carries THIS nonce, and that its receipt actually landed the
// transfer. A regression here releases resources for free.
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.settle() - consumed-nonce rescue (security)", () => {
  const RESCUE_NONCE = "0x5711cafe01";
  /**
   * A facilitator that has already ATTEMPTED this authorization, which the
   * rescue now requires: a settled SNIP-9 payload is public, so a rescue with
   * no local attempt on record is a third party replaying someone else's
   * completed payment, not a retry.
   *
   * Models the realistic sequence: we broadcast, the broadcast failed for us,
   * and meanwhile the authorization executed. The failed broadcast records the
   * attempt and releases the in-flight guard, leaving the retry free to rescue.
   *
   * @param opts - Chain state the rescue attempt should observe
   * @param requirements - The payment requirements
   * @param nonce - The SNIP-9 nonce under test
   * @returns The facilitator, primed with an attempt on record
   */
  async function facilitatorWithPriorAttempt(
    opts: MockOpts,
    requirements: PaymentRequirements,
    nonce: string,
  ): Promise<ExactStarknetScheme> {
    let broadcastShouldFail = true;
    const signer: FacilitatorStarknetSigner = {
      getAddresses: () => [FEE_PAYER],
      executeFromOutside: async () => {
        if (broadcastShouldFail) throw new Error("broadcast failed");
        return { transactionHash: "0x0abc" };
      },
    };
    let current: MockOpts = {};
    const facilitator = new ExactStarknetScheme(signer, {
      providerFactory: () => mockProvider(current),
    });
    await facilitator.settle(buildPayload(requirements, nonce), requirements);
    broadcastShouldFail = false;
    current = opts;
    return facilitator;
  }

  /**
   * A payload whose window has already closed. Verification rejects it at the
   * time-window check (which precedes every onchain read), and
   * `outside_execution_expired` is rescuable - so the rescue path runs and its
   * own gates decide the outcome. Without this, a negative test rejects earlier
   * (bad signature, undeployed account) and never reaches the code it names.
   *
   * @param accepted - The payment requirements to echo
   * @param nonce - The SNIP-9 nonce
   * @returns A structurally valid but expired payment payload
   */
  function buildExpiredPayload(accepted: PaymentRequirements, nonce: string): PaymentPayload {
    const now = nowSec();
    const typedData = buildCanonicalOutsideExecutionTypedData(SEPOLIA_CHAIN_ID, {
      Caller: FEE_PAYER,
      Nonce: nonce,
      "Execute After": String(now - 600),
      "Execute Before": String(now - 10),
      Calls: [{ To: ASSET, Selector: TRANSFER_SELECTOR, Calldata: [PAY_TO, "0x2710", "0x0"] }],
    });
    return {
      x402Version: 2,
      accepted,
      payload: { from: FROM, outsideExecution: { typedData, signature: ["0x1a2b", "0x3c4d"] } },
    };
  }

  it("reports idempotent success when the nonce is consumed and the transfer landed", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, RESCUE_NONCE);
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: true,
        landedTx: "0x01a0ded01",
        txTrace: consumingTrace(RESCUE_NONCE),
      },
      requirements,
      RESCUE_NONCE,
    );

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0x01a0ded01");
    expect(result.payer).toBe(FROM);
  });

  // The oracle that shipped once before: a forged payload naming a victim's
  // recent transfer must never rescue-succeed. EXPIRED is emitted BEFORE
  // verify's onchain signature check, so the rescue path has to re-verify the
  // signature itself rather than inheriting verification's word for it.
  it("never rescues a payload whose signature does not validate onchain", async () => {
    const requirements = buildRequirements();
    const payload = buildExpiredPayload(requirements, RESCUE_NONCE);
    const facilitator = await facilitatorWithPriorAttempt(
      {
        sig: "0x0", // is_valid_signature returns something other than VALID
        nonceUsed: true,
        landedTx: "0x0c17117a5",
        txTrace: consumingTrace(RESCUE_NONCE),
      },
      requirements,
      RESCUE_NONCE,
    );

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.transaction).toBe("");
  });

  it("never rescues when the account is not deployed", async () => {
    const requirements = buildRequirements();
    const payload = buildExpiredPayload(requirements, RESCUE_NONCE);
    const facilitator = await facilitatorWithPriorAttempt(
      {
        notDeployed: true,
        nonceUsed: true,
        landedTx: "0x01a0ded01",
        txTrace: consumingTrace(RESCUE_NONCE),
      },
      requirements,
      RESCUE_NONCE,
    );

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
  });

  // Matching only on (payer, payTo, amount) would let an unrelated same-amount
  // payment be claimed as this one.
  it("refuses a landed transfer whose transaction does not carry this nonce", async () => {
    const requirements = buildRequirements();
    const payload = buildExpiredPayload(requirements, RESCUE_NONCE);
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: true,
        landedTx: "0x050e0e1e5",
        txTrace: consumingTrace("0xdeadbeef"), // a DIFFERENT nonce
      },
      requirements,
      // The attempt MUST be recorded under the nonce actually being settled.
      // Recording it under the calldata's nonce instead makes the rescue bail at
      // the attempt-record gate, so the nonce-binding check never runs and this
      // test passes for the wrong reason.
      RESCUE_NONCE,
    );

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    // Nothing may be credited: the landed transaction consumed some OTHER
    // authorization, so it is not this payment however well it otherwise matches.
    expect(result.transaction).toBe("");
    // The rescue attributed nothing, so the original verification failure stands.
    expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.EXPIRED);
  });

  // The one-tx-one-nonce binding must hold on the RESCUE path too, not just at
  // broadcast. Otherwise a payer who pipelines two authorizations could have the
  // single transaction that settled the first one rescued as the second, turning
  // one onchain payment into two resource releases.
  it("refuses to rescue a transaction already credited to another authorization", async () => {
    const requirements = buildRequirements();
    const shared = "0x0f100beef";
    const nonceA = "0x5711bb01";
    const nonceB = "0x5711bb02";

    let current: MockOpts = {};
    let broadcastFails = false;
    const signer: FacilitatorStarknetSigner = {
      getAddresses: () => [FEE_PAYER],
      executeFromOutside: async () => {
        if (broadcastFails) throw new Error("broadcast failed");
        return { transactionHash: shared };
      },
    };
    const facilitator = new ExactStarknetScheme(signer, {
      providerFactory: () => mockProvider(current),
    });

    // A settles normally, binding `shared` to nonce A.
    const first = await facilitator.settle(buildPayload(requirements, nonceA), requirements);
    expect(first.success).toBe(true);
    expect(first.transaction).toBe(shared);

    // B is attempted but never broadcasts, leaving only an attempt record.
    broadcastFails = true;
    await facilitator.settle(buildPayload(requirements, nonceB), requirements);

    // B is retried once its nonce reads consumed. The only landed transfer is
    // `shared`, which already belongs to A, so B must not be credited with it.
    current = { nonceUsed: true, landedTx: shared, txTrace: consumingTrace(nonceB) };
    const second = await facilitator.settle(
      buildExpiredPayload(requirements, nonceB),
      requirements,
    );
    expect(second.success).toBe(false);
    expect(second.transaction).toBe("");
  });

  // A rescue may only credit a payment the authorization actually executed. An
  // UNUSED nonce proves nothing executed, so no onchain transfer - however
  // perfectly it matches payer/payTo/amount - may be attributed to it.
  it("refuses to rescue while the nonce is still unused", async () => {
    const requirements = buildRequirements();
    const nonce = "0x5711cafe02";
    const payload = buildExpiredPayload(requirements, nonce);
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: false,
        landedTx: "0x0a1e1a7ed",
        txTrace: consumingTrace(nonce),
      },
      requirements,
      nonce,
    );

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
    expect(result.transaction).toBe("");
  });

  // An expired payload short-circuits verification BEFORE the onchain nonce
  // read, so with no attempt on record the facilitator has no evidence the
  // nonce was ever consumed - it must report the expiry it observed, not claim
  // a consumption it never checked.
  it("reports expiry, not nonce consumption, for an expired never-attempted payload", async () => {
    const requirements = buildRequirements();
    const signer: FacilitatorStarknetSigner = {
      getAddresses: () => [FEE_PAYER],
      executeFromOutside: async () => ({ transactionHash: "0x0abc" }),
    };
    const facilitator = new ExactStarknetScheme(signer, {
      providerFactory: () => mockProvider({}),
    });

    const result = await facilitator.settle(
      buildExpiredPayload(requirements, "0x5711bb03"),
      requirements,
    );

    expect(result.success).toBe(false);
    expect(result.transaction).toBe("");
    expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.EXPIRED);
  });

  // The nonce is chosen by whoever built the authorization, so a payer can pick
  // one that occurs naturally in an ordinary transfer's calldata (the recipient
  // felt, a length, `1`). Matching on containment alone would let an unrelated
  // transfer of the right size be credited as this payment.
  it("refuses a transaction that never called execute_from_outside_v2 on the payer", async () => {
    const requirements = buildRequirements();
    // Nonce = felt(payTo), which any transfer to payTo contains.
    const nonce = PAY_TO;
    const payload = buildExpiredPayload(requirements, nonce);
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: true,
        landedTx: "0x0a1d7a",
        // An ordinary transfer: no execute_from_outside_v2 frame in its trace.
        txTrace: transferOnlyTrace(),
      },
      requirements,
      nonce,
    );

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
    expect(result.transaction).toBe("");
  });

  // The scan window is a claim about TIME, but it is expressed to the node as a
  // block range. A fixed block count only means "the last few hours" at one
  // particular block speed; at a faster one it silently becomes "the last few
  // minutes", and a payment that really landed falls outside the search and is
  // reported as unpaid.
  it("widens the scan window when blocks are fast", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const nonce = "0x5711ce80";
      const head = 1_000_000;
      const facilitator = await facilitatorWithPriorAttempt(
        {
          nonceUsed: true,
          landedTx: "0x0a1d80",
          txTrace: consumingTrace(nonce),
          headBlock: head,
          secondsPerBlock: 2,
        },
        requirements,
        nonce,
      );

      // The attempt is two hours old, so the consuming transaction can be too.
      vi.setSystemTime(NOW_MS + 2 * 60 * 60 * 1000);
      await facilitator.settle(buildExpiredPayload(requirements, nonce), requirements);

      const keyed = eventQueries.find(q => (q.keys?.length ?? 0) === 3);
      expect(keyed).toBeDefined();
      const blocksScanned = head - (keyed?.from_block?.block_number ?? head);
      // Two hours at two seconds a block is 3600 blocks, before the margin -
      // far past the 500-block floor a fixed window would have used.
      expect(blocksScanned).toBeGreaterThan(3600);
    } finally {
      vi.useRealTimers();
    }
  });

  // The caller conjunct, isolated. A SNIP-9 nonce is per-account, so the payer
  // can consume this very nonce with a DIFFERENT authorization it signed
  // itself - one naming ANY_CALLER, which no facilitator is bound to. That is
  // not the authorization the merchant was promised, and crediting it would let
  // a payer settle a purchase with a payment it controlled end to end.
  it("refuses a same-nonce authorization bound to a different caller", async () => {
    const requirements = buildRequirements();
    const nonce = "0x5711ce78";
    const payload = buildExpiredPayload(requirements, nonce);
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: true,
        landedTx: "0x0a1d7c",
        // Executes on the payer and carries this nonce, but the OutsideExecution
        // names the any-caller sentinel, not the feePayer this authorization is
        // bound to.
        txTrace: consumingTrace(nonce, { caller: ANY_CALLER }),
      },
      requirements,
      nonce,
    );

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
    expect(result.transaction).toBe("");
  });

  // The guard must be consulted again immediately before crediting, not only
  // at rescue entry: the search is many RPC round-trips, and a concurrent
  // settlement of a fresh same-(payer, nonce) payload can hold the guard and
  // land inside that window. Crediting then would report one payment twice.
  it("refuses to credit when the guard was claimed during the search", async () => {
    const requirements = buildRequirements();
    const nonce = "0x5711ce81";
    const cache = new SettlementCache();
    let broadcastShouldFail = true;
    const signer: FacilitatorStarknetSigner = {
      getAddresses: () => [FEE_PAYER],
      executeFromOutside: async () => {
        if (broadcastShouldFail) throw new Error("broadcast failed");
        return { transactionHash: "0x0abc" };
      },
    };
    let current: MockOpts = {};
    const facilitator = new ExactStarknetScheme(
      signer,
      { providerFactory: () => mockProvider(current) },
      cache,
    );
    await facilitator.settle(buildPayload(requirements, nonce), requirements);
    broadcastShouldFail = false;
    current = {
      nonceUsed: true,
      txTrace: consumingTrace(nonce),
      eventPages: () => {
        // A concurrent settlement claims the guard mid-search.
        cache.hold(nonceKey(FROM, nonce), NOW_SEC + 300);
        return {
          events: [{ ...assetTransfer(), transaction_hash: "0x0a1d90" }],
          continuation_token: undefined,
        };
      },
    };

    const result = await facilitator.settle(buildExpiredPayload(requirements, nonce), requirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
    expect(result.transaction).toBe("");
  });

  // The legacy unkeyed layout admits no participant filter, and getEvents
  // returns ascending from from_block - so a single wide window would spend its
  // budget on the oldest unrelated events. The pass walks sub-windows backward
  // from the head; a consuming transaction hundreds of blocks back is still
  // found, where a single fixed window from the head would miss it.
  it("finds a legacy-layout consuming tx beyond one sub-window from the head", async () => {
    const requirements = buildRequirements();
    const nonce = "0x5711ce82";
    const payload = buildExpiredPayload(requirements, nonce);
    const PLANTED_BLOCK = 750; // head is 1000; 250 back - past the 50-block width
    const legacyRanges: Array<[number, number]> = [];
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: true,
        txTrace: consumingTrace(nonce),
        eventPages: filter => {
          const f = filter as {
            keys?: string[][];
            from_block?: { block_number: number };
            to_block?: { block_number: number } | string;
          };
          if ((f.keys?.length ?? 0) === 3) return { events: [], continuation_token: undefined };
          const lo = f.from_block?.block_number ?? 0;
          const hi = typeof f.to_block === "object" ? f.to_block.block_number : 1000;
          legacyRanges.push([lo, hi]);
          if (lo <= PLANTED_BLOCK && PLANTED_BLOCK <= hi) {
            return {
              events: [
                {
                  from_address: ASSET,
                  keys: [TRANSFER_EVENT_KEY],
                  data: [FROM, PAY_TO, "0x2710", "0x0"],
                  transaction_hash: "0x0a1d91",
                },
              ],
              continuation_token: undefined,
            };
          }
          return { events: [], continuation_token: undefined };
        },
      },
      requirements,
      nonce,
    );

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(true);
    expect(BigInt(result.transaction)).toBe(BigInt("0x0a1d91"));
    // The walk moved backward: strictly descending upper bounds.
    expect(legacyRanges.length).toBeGreaterThan(1);
    for (let i = 1; i < legacyRanges.length; i++) {
      expect(legacyRanges[i][1]).toBeLessThan(legacyRanges[i - 1][1]);
    }
  });

  // The package's own paymaster signer settles through a forwarder: the
  // relayer's transaction calls the forwarder contract, which calls the payer.
  // The identity check reads trace frames, so the nested topology is found the
  // same way as the direct one - a top-level calldata scan could not see it,
  // and the facilitator's own broadcasts would have been unrescuable.
  it("rescues a settlement routed through a paymaster forwarder", async () => {
    const requirements = buildRequirements();
    const nonce = "0x5711ce79";
    const payload = buildExpiredPayload(requirements, nonce);
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: true,
        landedTx: "0x0a1d7d",
        txTrace: forwardedTrace(nonce),
      },
      requirements,
      nonce,
    );

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(true);
    expect(BigInt(result.transaction)).toBe(BigInt("0x0a1d7d"));
  });

  // The callee conjunct, isolated. Here the transaction DOES call
  // execute_from_outside_v2 carrying this exact nonce - but on a different
  // account. Only the callee check separates it from a genuine consuming
  // transaction, so without it an attacker's own OutsideExecution could be
  // credited as the payer's payment.
  it("refuses an execute_from_outside_v2 carrying this nonce on a different account", async () => {
    const requirements = buildRequirements();
    const nonce = "0x5711ce77";
    const payload = buildExpiredPayload(requirements, nonce);
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: true,
        landedTx: "0x0a1d7b",
        // The frame exists and carries this nonce, but executes on PAY_TO's
        // account rather than the payer's.
        txTrace: consumingTrace(nonce, { on: PAY_TO }),
      },
      requirements,
      nonce,
    );

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
    expect(result.transaction).toBe("");
  });

  // Spec step 5 requires the consuming transaction's RECEIPT to show
  // execution_status SUCCEEDED. A candidate still sitting in the pending block
  // that later gets dropped would otherwise be reported as a completed payment.
  it("refuses a candidate whose receipt is not SUCCEEDED", async () => {
    const requirements = buildRequirements();
    const payload = buildExpiredPayload(requirements, RESCUE_NONCE);
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: true,
        landedTx: "0x0e5e7ed2",
        txTrace: consumingTrace(RESCUE_NONCE),
        receiptStatus: "REVERTED",
      },
      requirements,
      RESCUE_NONCE,
    );

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    // The rescue refused, so settle reports verification's own reason and
    // crucially carries NO transaction hash: nothing was credited.
    expect(result.transaction).toBe("");
  });

  it("refuses a candidate whose receipt does not contain the expected transfer", async () => {
    const requirements = buildRequirements();
    const payload = buildExpiredPayload(requirements, RESCUE_NONCE);
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: true,
        landedTx: "0x00effec7",
        txTrace: consumingTrace(RESCUE_NONCE),
        receiptEvents: [],
      },
      requirements,
      RESCUE_NONCE,
    );

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
  });

  it("ignores a same-amount Transfer emitted by a different token", async () => {
    const requirements = buildRequirements();
    const payload = buildExpiredPayload(requirements, RESCUE_NONCE);
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: true,
        landedTx: "0x0a0c0d0e1",
        txTrace: consumingTrace(RESCUE_NONCE),
        landedEvent: {
          from_address: "0x0999999999999999999999999999999999999999999999999999999999999999",
          keys: [TRANSFER_EVENT_KEY, FROM, PAY_TO],
          data: ["0x2710", "0x0"],
        },
      },
      requirements,
      RESCUE_NONCE,
    );

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
  });

  // The legacy unkeyed ERC-20 layout carries from/to in `data`, so a scan that
  // filters on three indexed keys can never see it.
  // The keyed pass pushes payer/payTo down to the node, so a busy asset cannot
  // flood the page budget. A selector-only scan would spend its whole budget on
  // the OLDEST transfers in the window (getEvents returns ascending block order)
  // and never reach this payment, silently turning step 5 into a no-op.
  it("finds the payment on a busy asset without exhausting the page budget", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, RESCUE_NONCE);
    const noise = (i: number) => ({
      from_address: ASSET,
      keys: [TRANSFER_EVENT_KEY, `0x${(0xaa00 + i).toString(16)}`, PAY_TO],
      data: ["0x2710", "0x0"],
      transaction_hash: `0x${(0xbb00 + i).toString(16)}`,
    });
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: true,
        txTrace: consumingTrace(RESCUE_NONCE),
        eventPages: filter => {
          // Selector-only (legacy) pass: an unbounded stream of other people's
          // transfers, exactly what a real busy token looks like.
          if ((filter.keys?.length ?? 0) === 1) {
            return {
              events: Array.from({ length: 100 }, (_, i) => noise(i)),
              continuation_token: "more",
            };
          }
          // Keyed pass: the node filtered by payer/payTo, so only ours comes back.
          return {
            events: [{ ...assetTransfer(), transaction_hash: "0x01a0ded01" }],
            continuation_token: undefined,
          };
        },
      },
      requirements,
      RESCUE_NONCE,
    );

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0x01a0ded01");
    // The narrow filter must be pushed to the NODE, carrying the payer and
    // payTo felts - not applied locally after fetching everything.
    const keyed = eventQueries.find(q => (q.keys?.length ?? 0) === 3);
    expect(keyed).toBeDefined();
    expect(BigInt(keyed!.keys![1][0])).toBe(BigInt(FROM));
    expect(BigInt(keyed!.keys![2][0])).toBe(BigInt(PAY_TO));
    expect(BigInt(keyed!.address!)).toBe(BigInt(ASSET));
  });

  // execution_status is SUCCEEDED on a pending-block receipt too, and a pending
  // transaction can still be dropped. Only finality makes it safe to trust.
  it("refuses a candidate that is only in the pending block", async () => {
    const requirements = buildRequirements();
    const payload = buildExpiredPayload(requirements, RESCUE_NONCE);
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: true,
        landedTx: "0x0bede1a6",
        txTrace: consumingTrace(RESCUE_NONCE),
        receiptStatus: "SUCCEEDED",
        finalityStatus: "RECEIVED",
        blockNumber: null,
      },
      requirements,
      RESCUE_NONCE,
    );

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    // The rescue refused, so settle reports verification's own reason and
    // crucially carries NO transaction hash: nothing was credited.
    expect(result.transaction).toBe("");
  });

  it("refuses a candidate whose receipt reports no block number", async () => {
    const requirements = buildRequirements();
    const payload = buildExpiredPayload(requirements, RESCUE_NONCE);
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: true,
        landedTx: "0x0bede1a7",
        txTrace: consumingTrace(RESCUE_NONCE),
        finalityStatus: "ACCEPTED_ON_L2",
        blockNumber: null,
      },
      requirements,
      RESCUE_NONCE,
    );

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
  });

  it("rescues a transfer emitted in the legacy unkeyed Transfer layout", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, RESCUE_NONCE);
    const legacyTransfer = {
      from_address: ASSET,
      keys: [TRANSFER_EVENT_KEY],
      data: [FROM, PAY_TO, "0x2710", "0x0"],
    };
    const facilitator = await facilitatorWithPriorAttempt(
      {
        nonceUsed: true,
        landedTx: "0x01e6ac1a",
        txTrace: consumingTrace(RESCUE_NONCE),
        landedEvent: legacyTransfer,
        receiptEvents: [legacyTransfer],
      },
      requirements,
      RESCUE_NONCE,
    );

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0x01e6ac1a");
  });
});

// ---------------------------------------------------------------------------
// settle() - rescue-replay guard
//
// One landed transaction must never be attributed to more than one nonce.
// Without this, a self-attesting account could turn a single onchain payment
// into unlimited free resource releases (pay-1-get-N).
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.settle() - one-tx-one-nonce at the settle path", () => {
  // The cache-level guard is tested directly elsewhere; this binds its USE in
  // runSettlement. An executor that returns the same hash for two different
  // authorizations would otherwise have one payment credited twice.
  it("refuses to credit one settlement transaction to a second authorization", async () => {
    const requirements = buildRequirements();
    const shared = "0x0f100570a";
    const signer: FacilitatorStarknetSigner = {
      getAddresses: () => [FEE_PAYER],
      executeFromOutside: async () => ({ transactionHash: shared }),
    };
    const facilitator = new ExactStarknetScheme(signer, {
      providerFactory: () => mockProvider({}),
    });

    const first = await facilitator.settle(buildPayload(requirements, "0x5711dd01"), requirements);
    expect(first.success).toBe(true);

    // A DIFFERENT authorization, same landed hash.
    const second = await facilitator.settle(buildPayload(requirements, "0x5711dd02"), requirements);
    expect(second.success).toBe(false);
    expect(second.errorReason).toBe("unexpected_settle_error");
  });
});

describe("SettlementCache - rescue-replay guard", () => {
  // One onchain transaction must never be attributed to more than one
  // authorization, or a single payment could release the resource N times.
  // Tested at the cache directly: reaching it through settle() would require
  // defeating the attempt gate first, and both gates should be verified.
  const NONCE_A = "0x5711aa01";
  const NONCE_B = "0x5711aa02";

  it("refuses to attribute one landed transaction to a second nonce", () => {
    const cache = new SettlementCache();
    expect(cache.bindTxToNonce("0x01ea0d01", FROM, NONCE_A)).toBe(true);
    expect(cache.bindTxToNonce("0x01ea0d01", FROM, NONCE_B)).toBe(false);
  });

  it("stays idempotent for repeated binds of the same nonce", () => {
    const cache = new SettlementCache();
    expect(cache.bindTxToNonce("0x01de3907e7", FROM, NONCE_A)).toBe(true);
    expect(cache.bindTxToNonce("0x01de3907e7", FROM, NONCE_A)).toBe(true);
  });

  // Transaction hashes are felts: the hash an executor returns and the hash
  // carried on a scanned event share no padding or case convention, so the
  // guard must key numerically or it silently fails to match.
  it("treats differently-formatted spellings of one tx hash as the same transaction", () => {
    const cache = new SettlementCache();
    expect(cache.bindTxToNonce("0x00abc", FROM, NONCE_A)).toBe(true);
    expect(cache.bindTxToNonce("0xABC", FROM, NONCE_B)).toBe(false);
  });

  it("refuses a hash that is not a felt", () => {
    const cache = new SettlementCache();
    expect(cache.bindTxToNonce("not-a-felt", FROM, NONCE_A)).toBe(false);
  });

  // The attempt record is what makes a rescue a retry rather than a replay.
  it("records an attempt on hold and reports it independently of the in-flight guard", () => {
    // The cache stamps attempts with Date.now(), so pin the clock rather than
    // mixing a synthetic eviction timestamp with real time.
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const cache = new SettlementCache();
      const key = nonceKey(FROM, NONCE_A);
      expect(cache.hasAttempted(key)).toBe(false);

      cache.hold(key, NOW_SEC + 300);
      expect(cache.isInFlight(key)).toBe(true);
      expect(cache.hasAttempted(key)).toBe(true);

      // Past the guard window the in-flight entry goes, but the attempt record
      // survives so a legitimate late retry can still rescue.
      cache.evictExpired(NOW_SEC + 400);
      expect(cache.isInFlight(key)).toBe(false);
      expect(cache.hasAttempted(key)).toBe(true);

      // Past the longer attempt window it goes too.
      cache.evictExpired(NOW_SEC + 5 * 60 * 60);
      expect(cache.hasAttempted(key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // A window advertised beyond the attempt TTL keeps the guard held past that
  // TTL. The attempt record must outlive the GUARD's eviction whatever the
  // window - including in the very sweep that evicts the guard - or the retry
  // that eviction exists to allow would be denied the rescue.
  it("keeps the attempt record until well past the guard's horizon", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const cache = new SettlementCache();
      const key = nonceKey(FROM, NONCE_A);
      // Guard held for six hours - past the four-hour attempt TTL.
      cache.hold(key, NOW_SEC + 6 * 60 * 60);

      // Five hours on, the attempt TTL has lapsed but the guard has not.
      cache.evictExpired(NOW_SEC + 5 * 60 * 60);
      expect(cache.isInFlight(key)).toBe(true);
      expect(cache.hasAttempted(key)).toBe(true);

      // Seven hours on, ONE sweep evicts the guard - and must not take the
      // attempt record with it in the same pass.
      cache.evictExpired(NOW_SEC + 7 * 60 * 60);
      expect(cache.isInFlight(key)).toBe(false);
      expect(cache.hasAttempted(key)).toBe(true);

      // The record finally ages out a full retention past the guard's horizon.
      cache.evictExpired(NOW_SEC + 11 * 60 * 60);
      expect(cache.hasAttempted(key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // A landed-tx binding must not die while any attempt could still scan back
  // to its transaction: once the binding is gone, the same transfer could be
  // credited to a SECOND near-simultaneous authorization - one payment, two
  // successes.
  it("keeps a tx binding while a living attempt can still reach it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const cache = new SettlementCache();
      const keyA = nonceKey(FROM, NONCE_A);
      const keyB = nonceKey(FROM, NONCE_B);
      cache.hold(keyA, NOW_SEC + 300);
      expect(cache.bindTxToNonce("0x01ea0dbb", FROM, NONCE_A)).toBe(true);
      // A second authorization attempted five minutes later - its rescue scan
      // reaches back past the binding time.
      vi.setSystemTime(NOW_MS + 5 * 60 * 1000);
      cache.hold(keyB, NOW_SEC + 5 * 60 + 300);

      // Past the binding's own TTL, but keyB's attempt is alive and reaches it:
      // the binding must survive, so rebinding to NONCE_B still refuses.
      cache.evictExpired(NOW_SEC + 4 * 60 * 60 + 60);
      expect(cache.bindTxToNonce("0x01ea0dbb", FROM, NONCE_B)).toBe(false);

      // Once every attempt that could reach it is gone, the binding may go too.
      cache.evictExpired(NOW_SEC + 12 * 60 * 60);
      expect(cache.bindTxToNonce("0x01ea0dbb", FROM, NONCE_B)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ExactStarknetScheme.settle() - replay of a settled payload", () => {
  // A settled SNIP-9 payload is public: signature included, compiled into the
  // settlement transaction's calldata. Anyone who reads the chain can replay
  // it. Without an attempt on record the facilitator must not hand a third
  // party a fresh success for someone else's completed payment.
  it("refuses to rescue an authorization this facilitator never attempted", async () => {
    const requirements = buildRequirements();
    const nonce = "0x5711bb01";
    const facilitator = makeFacilitator({
      nonceUsed: true,
      landedTx: "0x01a0ded09",
      txTrace: consumingTrace(nonce),
    });

    const result = await facilitator.settle(buildPayload(requirements, nonce), requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.NONCE_ALREADY_USED);
    expect(result.transaction).toBe("");
  });
});

describe("ExactStarknetScheme.settle() - reverted-settlement resolution (security)", () => {
  // SN-SEC-02. A revert rolls the SNIP-9 nonce back, so nothing executed. The
  // only rescuable case is another transaction having executed this same
  // authorization first, which requires the nonce to actually BE consumed.
  //
  // The nonce is chosen by whoever built the authorization, so a payer can pick
  // one that is guaranteed to appear in an ordinary transfer's calldata (the
  // recipient felt, the calldata length, `1`). Matching on mere containment
  // would let them force a revert and have an unrelated older transfer of the
  // right size credited as this payment.
  it("does not credit an unrelated transfer when the settlement reverted", async () => {
    const requirements = buildRequirements();
    // The attack nonce: felt(payTo), which occurs in any transfer to payTo.
    const payload = buildPayload(requirements, PAY_TO);
    const facilitator = makeFacilitator(
      {
        receiptStatus: "REVERTED",
        // The nonce is NOT consumed - the revert rolled it back.
        nonceUsed: false,
        landedTx: "0x0a1d7a",
        txTrace: transferOnlyTrace(),
      },
      "0x0bad1",
    );

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(INVALID_TRANSACTION_STATE);
    // The facilitator's own reverted broadcast is reported, never the
    // unrelated landed transfer.
    expect(result.transaction).toBe("0x0bad1");
  });

  it("does not accept a transaction that never called execute_from_outside_v2", async () => {
    const requirements = buildRequirements();
    const nonce = PAY_TO;
    const payload = buildPayload(requirements, nonce);
    const { facilitator, next } = makeStatefulFacilitator();

    // A first attempt that reverted puts this authorization on record, so the
    // retry below reaches the rescue's structural check instead of being turned
    // away at the attempt-binding gate.
    next({ receiptStatus: "REVERTED" }, "0x0bad2");
    const attempt = await facilitator.settle(payload, requirements);
    expect(attempt.errorReason).toBe(INVALID_TRANSACTION_STATE);

    // Even with the nonce reported consumed, an ordinary transfer is not the
    // transaction that consumed it.
    next({ nonceUsed: true, landedTx: "0x0a1d7a", txTrace: transferOnlyTrace() });
    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.NONCE_ALREADY_USED);
    expect(result.transaction).toBe("");
  });

  // The rescuable revert: another transaction executed this same authorization
  // first, so ours reverted on the consumed nonce. The rescue must credit THAT
  // transaction, never the facilitator's own reverted broadcast.
  it("credits the transaction that consumed the nonce when the settlement reverted on it", async () => {
    const requirements = buildRequirements();
    const nonce = "0x5711bb02";
    const base = mockProvider({ landedTx: "0x0a1d7b", txTrace: consumingTrace(nonce) });
    // The nonce reads as unused while the settlement is re-verified and
    // broadcast, and as consumed once the rescue re-checks it; the facilitator's
    // own transaction reverted, the consuming one succeeded.
    let nonceReads = 0;
    const provider = {
      ...base,
      async callContract(call: { entrypoint: string }, block?: string) {
        if (call.entrypoint === "is_valid_outside_execution_nonce") {
          nonceReads += 1;
          return nonceReads === 1 ? ["0x1"] : ["0x0"];
        }
        return base.callContract(call, block);
      },
      async getTransactionReceipt(txHash: string) {
        if (feltEquals(txHash, "0x0bad3")) {
          return {
            execution_status: "REVERTED",
            finality_status: "ACCEPTED_ON_L2",
            block_number: 1000,
            events: [],
          };
        }
        return base.getTransactionReceipt(txHash);
      },
    } as unknown as RpcProvider;
    const facilitator = new ExactStarknetScheme(makeSigner("0x0bad3"), {
      providerFactory: () => provider,
    });

    const result = await facilitator.settle(buildPayload(requirements, nonce), requirements);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0x0a1d7b");
  });
});
