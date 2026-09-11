import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hash, RpcError, typedData as snTypedData, type RpcProvider } from "starknet";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  InMemoryPendingSettlementStore,
  type PendingSettlementStore,
} from "@x402/core/facilitator";
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
    async waitForTransaction() {
      return {};
    },
    // Chain-search entry points the facilitator must never call; they throw so
    // a regression fails loudly.
    async getEvents() {
      throw new Error("getEvents must not be called: the facilitator never searches the chain");
    },
    async getTransactionTrace() {
      throw new Error("getTransactionTrace must not be called");
    },
    async getBlockNumber() {
      throw new Error("getBlockNumber must not be called");
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

/**
 * Like {@link makeStatefulFacilitator}, additionally counting broadcasts so a
 * test can assert an unresolved authorization was never sent twice.
 *
 * @returns The facilitator, a setter for the next call's chain state, and the broadcast count
 */
function makeCountingFacilitator(): {
  facilitator: ExactStarknetScheme;
  next: (opts: MockOpts, transactionHash?: string) => void;
  broadcasts: () => number;
  calls: () => string[];
} {
  let opts: MockOpts = {};
  let txHash = "0xabc";
  let broadcasts = 0;
  const calls: string[] = [];
  const signer: FacilitatorStarknetSigner = {
    getAddresses: () => [FEE_PAYER],
    executeFromOutside: async () => {
      broadcasts += 1;
      return { transactionHash: txHash };
    },
  };
  const facilitator = new ExactStarknetScheme(signer, {
    providerFactory: () => recordCalls(mockProvider(opts), calls),
  });
  return {
    facilitator,
    next: (o, t) => {
      opts = o;
      if (t !== undefined) txHash = t;
    },
    broadcasts: () => broadcasts,
    calls: () => calls,
  };
}

/**
 * Wrap a provider so every method call is recorded by name, letting a test
 * assert which RPC entry points a path did (not) touch.
 *
 * @param provider - The provider to wrap
 * @param calls - The array method names are appended to
 * @returns The recording proxy
 */
function recordCalls(provider: RpcProvider, calls: string[]): RpcProvider {
  return new Proxy(provider as object, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v === "function") {
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return v;
    },
  }) as RpcProvider;
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

  // After the guard is evicted, a retry of an already-settled payload is
  // TERMINAL. Re-verification observes the consumed nonce and reports it; the
  // facilitator never searches the chain for the transaction that consumed it
  // to hand out a second `success: true` - a settled SNIP-9 payload is public
  // (its signature sits in the settlement calldata), so that path would let
  // anyone replaying a scraped payment release the resource again.
  it("answers a post-eviction retry of a settled payload with a terminal failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const nonce = "0x5711e00d";
      const payload = buildPayload(requirements, nonce); // Execute Before = NOW + 300
      const { facilitator, next, broadcasts, calls } = makeCountingFacilitator();

      next({}, "0x0f1005703");
      const first = await facilitator.settle(payload, requirements);
      expect(first.success).toBe(true);

      // Past Execute Before + skew: the guard is evicted and the retry re-enters
      // verification. The guard outlives the window, so by the time it lapses
      // the authorization has expired - which verification reports before it
      // ever reads the nonce (an unread nonce is never asserted as consumed).
      vi.setSystemTime(NOW_MS + 400_000);
      next({ nonceUsed: true });
      const retry = await facilitator.settle(payload, requirements);
      expect(retry.success).toBe(false);
      expect(retry.errorReason).toBe(STARKNET_ERROR_REASONS.EXPIRED);
      expect(retry.transaction).toBe("");
      expect(calls()).not.toContain("getEvents");
      expect(calls()).not.toContain("getTransactionTrace");
      expect(calls()).not.toContain("getBlockNumber");
      expect(broadcasts()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // A forged payload naming a settled (payer, nonce) gets nothing from either
  // phase: duplicate_settlement inside the guard window, and after eviction
  // re-verification's onchain signature check rejects it - no cache entry may
  // ever vouch for a payload the account did not sign.
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
      // re-verification's onchain signature check rejects it.
      vi.setSystemTime(NOW_MS + 400_000);
      next({ sig: "0x0", nonceUsed: true });
      const forged = await facilitator.settle(buildPayload(requirements, nonce), requirements);
      expect(forged.success).toBe(false);
      expect(forged.errorReason).toBe(STARKNET_ERROR_REASONS.INVALID_SIGNATURE);
      expect(forged.transaction).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  // The race the early guard alone cannot catch: a concurrent straggler passes
  // the entry gate BEFORE the winner holds the guard, then completes its
  // re-verification AFTER the winner's broadcast consumed the nonce. It must
  // end terminally - one payment, one resource release, one broadcast.
  it("a concurrent straggler that sees the consumed nonce fails terminally and never broadcasts", async () => {
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
    expect(stragglerResult.errorReason).toBe(STARKNET_ERROR_REASONS.NONCE_ALREADY_USED);
    expect(stragglerResult.transaction).toBe("");

    releaseBroadcast({ transactionHash: "0x0bede1a7" });
    const winnerResult = await winner;
    expect(winnerResult.success).toBe(true);
    expect(broadcasts).toBe(1);
  });

  // Settlement step 4: `settlement_pending` is non-terminal, and the retry the
  // resource server issues with the identical payload reconciles against the
  // remembered broadcast - it is waited on, never re-broadcast.
  it("reconciles a retry after settlement_pending against the remembered broadcast", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e00b");
      const { facilitator, next, broadcasts } = makeCountingFacilitator();

      next({ receiptThrows: true }, "0x0bede1a6");
      const pending = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      const first = await pending;
      expect(first.success).toBe(false);
      expect(first.errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);
      expect(first.transaction).toBe("0x0bede1a6");

      // The node now answers: the same transaction landed with the transfer.
      next({});
      const retry = await facilitator.settle(payload, requirements);
      expect(retry.success).toBe(true);
      expect(retry.transaction).toBe("0x0bede1a6");
      expect(retry.amount).toBe("10000");
      expect(retry.payer).toBe(FROM);
      // The unresolved authorization must never be broadcast a second time.
      expect(broadcasts()).toBe(1);

      // The entry was consumed by the reconciliation: a further repeat inside
      // the guard window is a duplicate, not a second success.
      const again = await facilitator.settle(payload, requirements);
      expect(again.success).toBe(false);
      expect(again.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
      expect(broadcasts()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles without spending any verification read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e01b");
      const calls: string[] = [];
      let opts: MockOpts = { receiptThrows: true };
      const facilitator = new ExactStarknetScheme(makeSigner("0x0bede1b6"), {
        providerFactory: () => {
          const base = mockProvider(opts);
          return new Proxy(base as object, {
            get(target, prop, receiver) {
              const v = Reflect.get(target, prop, receiver);
              if (typeof v === "function") {
                return (...args: unknown[]) => {
                  calls.push(String(prop));
                  return (v as (...a: unknown[]) => unknown).apply(target, args);
                };
              }
              return v;
            },
          }) as RpcProvider;
        },
      });

      const pending = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      expect((await pending).errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);

      calls.length = 0;
      opts = {};
      const retry = await facilitator.settle(payload, requirements);
      expect(retry.success).toBe(true);
      // Only the receipt was read: no class hash, signature, nonce, balance or
      // simulation - the remembered broadcast is trusted as this facilitator's own.
      expect(new Set(calls)).toEqual(new Set(["getTransactionReceipt"]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays settlement_pending, and remembers the hash again, while the broadcast is still unconfirmed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e01c");
      const { facilitator, next, broadcasts } = makeCountingFacilitator();

      next({ receiptThrows: true }, "0x0bede1c6");
      const pending = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      expect((await pending).errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);

      const retryPending = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      const retry = await retryPending;
      expect(retry.success).toBe(false);
      expect(retry.errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);
      expect(retry.transaction).toBe("0x0bede1c6");

      // A later retry still finds the hash and can resolve it.
      next({});
      const resolved = await facilitator.settle(payload, requirements);
      expect(resolved.success).toBe(true);
      expect(resolved.transaction).toBe("0x0bede1c6");
      expect(broadcasts()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the guard when the remembered broadcast turns out REVERTED, so a fresh settle may re-broadcast", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e01d");
      const { facilitator, next, broadcasts } = makeCountingFacilitator();

      next({ receiptThrows: true }, "0x0bede1d6");
      const pending = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      expect((await pending).errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);

      next({ receiptStatus: "REVERTED" });
      const retry = await facilitator.settle(payload, requirements);
      expect(retry.success).toBe(false);
      expect(retry.errorReason).toBe(INVALID_TRANSACTION_STATE);
      expect(retry.transaction).toBe("0x0bede1d6");
      expect(broadcasts()).toBe(1);

      // The revert rolled the nonce back: the authorization is retryable, and
      // this time it is a fresh settlement with a new broadcast.
      next({}, "0x0bede1d7");
      const fresh = await facilitator.settle(payload, requirements);
      expect(fresh.success).toBe(true);
      expect(fresh.transaction).toBe("0x0bede1d7");
      expect(broadcasts()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the guard when the remembered broadcast SUCCEEDED without the transfer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e01e");
      const { facilitator, next, broadcasts } = makeCountingFacilitator();

      next({ receiptThrows: true }, "0x0bede1e6");
      const pending = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      expect((await pending).errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);

      next({ receiptEvents: [] });
      const retry = await facilitator.settle(payload, requirements);
      expect(retry.success).toBe(false);
      expect(retry.errorReason).toBe(INVALID_TRANSACTION_STATE);
      expect(retry.transaction).toBe("0x0bede1e6");

      // The nonce is spent, so nothing may be re-broadcast: a repeat is a duplicate.
      const repeat = await facilitator.settle(payload, requirements);
      expect(repeat.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
      expect(broadcasts()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Two retries of the same payload can both observe the pending entry before
  // either removes it (the store's get and delete are two awaits apart). Only
  // one may reconcile, or one payment would be reported as two successes.
  it("lets exactly one of two concurrent retries reconcile a pending broadcast", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e01f");
      const { facilitator, next } = makeCountingFacilitator();

      next({ receiptThrows: true }, "0x0bede1f6");
      const pending = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      expect((await pending).errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);

      next({});
      const [a, b] = await Promise.all([
        facilitator.settle(payload, requirements),
        facilitator.settle(payload, requirements),
      ]);
      const outcomes = [a, b].map(r => r.success);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const loser = [a, b].find(r => !r.success)!;
      expect(loser.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
    } finally {
      vi.useRealTimers();
    }
  });

  // The store is asynchronous by contract precisely so it can be shared: a
  // retry landing on another replica reconciles as long as both replicas see
  // the same entries.
  it("reconciles a retry on a different facilitator instance sharing the pending store", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e020");
      const store = new InMemoryPendingSettlementStore();
      let replicaBroadcasts = 0;
      const replicaSigner: FacilitatorStarknetSigner = {
        getAddresses: () => [FEE_PAYER],
        executeFromOutside: async () => {
          replicaBroadcasts += 1;
          return { transactionHash: "0x0bede206" };
        },
      };
      const first = new ExactStarknetScheme(makeSigner("0x0bede205"), {
        providerFactory: () => mockProvider({ receiptThrows: true }),
        pendingSettlementStore: store,
      });
      const replica = new ExactStarknetScheme(replicaSigner, {
        providerFactory: () => mockProvider({}),
        pendingSettlementStore: store,
      });

      const pending = first.settle(payload, requirements);
      await vi.runAllTimersAsync();
      expect((await pending).errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);
      expect(Object.values(store.entriesSnapshot())).toEqual(["0x0bede205"]);

      const retry = await replica.settle(payload, requirements);
      expect(retry.success).toBe(true);
      expect(retry.transaction).toBe("0x0bede205");
      expect(replicaBroadcasts).toBe(0);
      expect(store.entriesSnapshot()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  // The key must bind the whole signed authorization, not just (payer, nonce):
  // a different payload sharing the nonce is a different authorization and
  // must not inherit the remembered broadcast.
  it("keys the pending entry by the signed authorization, not by nonce alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const nonce = "0x5711e021";
      // Built once: the confirmation wait advances the fake clock, so a second
      // buildMessage would sign different time bounds and hash differently.
      const canonical = buildCanonicalOutsideExecutionTypedData(
        SEPOLIA_CHAIN_ID,
        buildMessage(nonce),
      );
      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: requirements,
        payload: {
          from: FROM,
          outsideExecution: { typedData: canonical, signature: ["0x1a2b", "0x3c4d"] },
        },
      };
      const store = new InMemoryPendingSettlementStore();
      const facilitator = new ExactStarknetScheme(makeSigner("0x0bede216"), {
        providerFactory: () => mockProvider({ receiptThrows: true }),
        pendingSettlementStore: store,
      });

      const pending = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      expect((await pending).errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);
      const messageHash = BigInt(snTypedData.getMessageHash(canonical, FROM)).toString();
      expect(store.entriesSnapshot()).toEqual({ [messageHash]: "0x0bede216" });

      // Same nonce, different recipient: a different authorization. It is not
      // reconciled against the remembered broadcast; it meets the guard.
      const other = buildPayload({ ...requirements, payTo: FEE_PAYER }, nonce);
      const result = await facilitator.settle(other, { ...requirements, payTo: FEE_PAYER });
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
      expect(store.entriesSnapshot()).toEqual({ [messageHash]: "0x0bede216" });
    } finally {
      vi.useRealTimers();
    }
  });

  // If the hash cannot be persisted, a retry would have nothing to reconcile
  // against and would be told duplicate_settlement, so `settlement_pending`
  // would be a promise the facilitator cannot keep. Report a terminal error
  // that still carries the hash for manual reconciliation.
  it("downgrades settlement_pending to a terminal error when the pending store cannot persist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e022");
      const store: PendingSettlementStore = {
        get: async () => undefined,
        set: async () => {
          throw new Error("redis down");
        },
        delete: async () => {},
      };
      const facilitator = new ExactStarknetScheme(makeSigner("0x0bede226"), {
        providerFactory: () => mockProvider({ receiptThrows: true }),
        pendingSettlementStore: store,
      });

      const pending = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("unexpected_settle_error");
      expect(result.transaction).toBe("0x0bede226");
      expect(result.errorMessage).not.toContain("redis");
    } finally {
      vi.useRealTimers();
    }
  });

  // Nothing may outlive the confirmation deadline: a poller still querying the
  // node after the settlement has resolved would run for the life of the
  // process, on every settlement.
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
  // outcome: the hash is remembered and reported for reconciliation rather than
  // releasing the authorization for an immediate re-broadcast, and a retry waits
  // on that same hash again.
  it("keeps a pre-confirmed REVERTED receipt unresolved until it is in a block", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e012");
      const { facilitator, next, broadcasts } = makeCountingFacilitator();
      next(
        { receiptStatus: "REVERTED", finalityStatus: "PRE_CONFIRMED", blockNumber: null },
        "0x0bede1ac",
      );

      const promise = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);
      expect(result.transaction).toBe("0x0bede1ac");

      const repeatPromise = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      const repeat = await repeatPromise;
      expect(repeat.errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);
      expect(repeat.transaction).toBe("0x0bede1ac");
      expect(broadcasts()).toBe(1);

      // Once the revert is in a block it is an outcome: the guard is released.
      next({ receiptStatus: "REVERTED" });
      const settled = await facilitator.settle(payload, requirements);
      expect(settled.errorReason).toBe(INVALID_TRANSACTION_STATE);
      expect(settled.transaction).toBe("0x0bede1ac");
      expect(broadcasts()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Finality is ACCEPTED_ON_L2 or deeper: an L1-accepted receipt is settled too.
  it("accepts an ACCEPTED_ON_L1 receipt", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e011");
    const facilitator = makeFacilitator({ finalityStatus: "ACCEPTED_ON_L1" }, "0x0bede1a9");

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0x0bede1a9");
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
// settle() - a consumed nonce is terminal
//
// SECURITY. A settled SNIP-9 payload is public: its signature is compiled into
// the settlement transaction's calldata, so anyone who reads the chain can
// replay it to /settle. The only path back to `success: true` is the remembered
// broadcast hash above, for a settlement this facilitator left unresolved; a
// consumed nonce on any other request, including one whose earlier success
// response was lost in transit, is reported, never resolved.
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.settle() - replay of a settled payload", () => {
  it("reports nonce_already_used for a payload this facilitator never broadcast", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e030");
    const facilitator = makeFacilitator({ nonceUsed: true }, "0x0f100570b");

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.NONCE_ALREADY_USED);
    expect(result.transaction).toBe("");
    // The payer's signature was verified before the nonce read, so it is echoed.
    expect(result.payer).toBe(FROM);
  });

  it("never searches the chain for the transaction that consumed the nonce", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e031");
    const calls: string[] = [];
    const facilitator = new ExactStarknetScheme(makeSigner("0x0f100570c"), {
      providerFactory: () => {
        const base = mockProvider({ nonceUsed: true });
        return new Proxy(base as object, {
          get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver);
            if (typeof v === "function") {
              return (...args: unknown[]) => {
                calls.push(String(prop));
                return (v as (...a: unknown[]) => unknown).apply(target, args);
              };
            }
            return v;
          },
        }) as RpcProvider;
      },
    });

    const result = await facilitator.settle(payload, requirements);

    expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.NONCE_ALREADY_USED);
    expect(calls).not.toContain("getEvents");
    expect(calls).not.toContain("getTransactionTrace");
    expect(calls).not.toContain("getTransactionReceipt");
  });

  it("reports expiry, not nonce consumption, for an expired payload it never read the nonce of", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e032");
      const facilitator = makeFacilitator({ nonceUsed: true }, "0x0f100570d");

      // Past Execute Before: verification rejects on the window before any
      // onchain read, and must report exactly what it observed.
      vi.setSystemTime(NOW_MS + 400_000);
      const result = await facilitator.settle(payload, requirements);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.EXPIRED);
      expect(result.transaction).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// settle() - reverted settlement
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.settle() - reverted settlement", () => {
  it("reports the revert with its hash and does not look for another transaction", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e040");
    const calls: string[] = [];
    const facilitator = new ExactStarknetScheme(makeSigner("0x0e5e7a2"), {
      providerFactory: () => {
        const base = mockProvider({ receiptStatus: "REVERTED" });
        return new Proxy(base as object, {
          get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver);
            if (typeof v === "function") {
              return (...args: unknown[]) => {
                calls.push(String(prop));
                return (v as (...a: unknown[]) => unknown).apply(target, args);
              };
            }
            return v;
          },
        }) as RpcProvider;
      },
    });

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(INVALID_TRANSACTION_STATE);
    expect(result.transaction).toBe("0x0e5e7a2");
    expect(calls).not.toContain("getEvents");
    expect(calls).not.toContain("getTransactionTrace");
  });
});

// ---------------------------------------------------------------------------
// SettlementCache - duplicate guard
// ---------------------------------------------------------------------------

describe("SettlementCache - duplicate guard", () => {
  it("holds a key until its horizon and evicts it afterwards", () => {
    const cache = new SettlementCache();
    const key = nonceKey(FROM, "0x1");
    expect(cache.isInFlight(key)).toBe(false);

    cache.hold(key, 1_000);
    expect(cache.isInFlight(key)).toBe(true);

    cache.evictExpired(999);
    expect(cache.isInFlight(key)).toBe(true);

    cache.evictExpired(1_000);
    expect(cache.isInFlight(key)).toBe(false);
  });

  it("releases a key on demand", () => {
    const cache = new SettlementCache();
    const key = nonceKey(FROM, "0x2");
    cache.hold(key, 1_000);
    cache.release(key);
    expect(cache.isInFlight(key)).toBe(false);
  });

  it("normalizes the key numerically across felt spellings", () => {
    expect(nonceKey(FROM, "0x0a")).toBe(nonceKey(FROM.replace("0x0", "0x"), "10"));
  });
});

// ---------------------------------------------------------------------------
// settle() - identification of the authorization before any RPC
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.settle() - authorization identification", () => {
  // Anything that does not identify must never reach the pending store or the
  // guard; verification rejects it with the precise reason.
  /** A facilitator whose store counts reads, to assert a path never touched it. */
  function facilitatorWithCountingStore(txHash: string): {
    facilitator: ExactStarknetScheme;
    gets: () => number;
  } {
    let gets = 0;
    const inner = new InMemoryPendingSettlementStore();
    const store: PendingSettlementStore = {
      async get(key) {
        gets += 1;
        return inner.get(key);
      },
      set: (key, tx) => inner.set(key, tx),
      delete: key => inner.delete(key),
    };
    const facilitator = new ExactStarknetScheme(makeSigner(txHash), {
      providerFactory: () => mockProvider({}),
      pendingSettlementStore: store,
    });
    return { facilitator, gets: () => gets };
  }

  it("rejects a payload with no inner payload as invalid_payload", async () => {
    const requirements = buildRequirements();
    const payload = { ...buildPayload(requirements, "0x5711e050"), payload: undefined };
    const { facilitator, gets } = facilitatorWithCountingStore("0x0f100571a");

    const result = await facilitator.settle(payload as unknown as PaymentPayload, requirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_payload");
    expect(gets()).toBe(0);
  });

  it("rejects a payer that is not an address", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e051");
    (payload.payload as { from: string }).from = "not-an-address";
    const { facilitator, gets } = facilitatorWithCountingStore("0x0f100571b");

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_payload");
    expect(gets()).toBe(0);
  });

  it("rejects typed data that does not parse", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e052");
    (payload.payload as { outsideExecution: { typedData: unknown } }).outsideExecution.typedData = {
      message: {},
    };
    const facilitator = makeFacilitator({}, "0x0f100571c");

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_payload");
  });

  it("rejects typed data signed for a different chain than the requirements name", async () => {
    const requirements = buildRequirements();
    const typedData = buildCanonicalOutsideExecutionTypedData(
      "0x534e5f4d41494e", // SN_MAIN
      buildMessage("0x5711e053"),
    );
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: { from: FROM, outsideExecution: { typedData, signature: ["0x1a2b", "0x3c4d"] } },
    };
    const facilitator = makeFacilitator({}, "0x0f100571d");

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_network");
  });

  it("rejects a transfer amount with a non-canonical limb", async () => {
    const requirements = buildRequirements();
    const message = buildMessage("0x5711e054");
    message.Calls[0].Calldata = [PAY_TO, "0x2710", "0x" + "1".repeat(33)];
    const typedData = buildCanonicalOutsideExecutionTypedData(SEPOLIA_CHAIN_ID, message);
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: { from: FROM, outsideExecution: { typedData, signature: ["0x1a2b", "0x3c4d"] } },
    };
    const { facilitator, gets } = facilitatorWithCountingStore("0x0f100571e");

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_payload");
    expect(gets()).toBe(0);
  });

  it("rejects an unsupported network before building a provider", async () => {
    const requirements = { ...buildRequirements(), network: "starknet:SN_NOPE" as const };
    const payload = buildPayload(requirements, "0x5711e055");
    let built = 0;
    const facilitator = new ExactStarknetScheme(makeSigner("0x0f100571f"), {
      providerFactory: () => {
        built += 1;
        return mockProvider({});
      },
    });

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_network");
    expect(built).toBe(0);
  });

  // Two settlements can both pass verification before either holds the guard
  // (each saw the nonce unused). The post-verification guard check is what
  // keeps the second from broadcasting the same authorization.
  it("stops the second of two fully-verified concurrent settlements at the guard", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e056");
    let balanceReads = 0;
    let releaseBalances: () => void = () => {};
    const bothVerifying = new Promise<void>(resolve => {
      releaseBalances = resolve;
    });
    let broadcasts = 0;
    const provider = mockProvider({}) as unknown as {
      callContract: (call: { entrypoint: string }, block?: string) => Promise<string[]>;
    };
    const inner = provider.callContract.bind(provider);
    provider.callContract = async (call, block) => {
      if (call.entrypoint === "balanceOf") {
        balanceReads += 1;
        if (balanceReads === 2) releaseBalances();
        // Park both verifications until both have read the balance, so neither
        // holds the guard before the other has finished its chain reads.
        await bothVerifying;
      }
      return inner(call, block);
    };
    const signer: FacilitatorStarknetSigner = {
      getAddresses: () => [FEE_PAYER],
      executeFromOutside: async () => {
        broadcasts += 1;
        return { transactionHash: "0x0bede1a9" };
      },
    };
    const facilitator = new ExactStarknetScheme(signer, {
      providerFactory: () => provider as unknown as RpcProvider,
    });

    const [a, b] = await Promise.all([
      facilitator.settle(payload, requirements),
      facilitator.settle(payload, requirements),
    ]);
    const winner = [a, b].find(r => r.success)!;
    const loser = [a, b].find(r => !r.success)!;
    expect(winner.transaction).toBe("0x0bede1a9");
    expect(loser.errorReason).toBe(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT);
    // The post-verification guard runs after the signature check, so it echoes the payer.
    expect(loser.payer).toBe(FROM);
    expect(broadcasts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// settle() - receipt shapes and provider faults
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.settle() - receipt shapes and provider faults", () => {
  // starknet.js returns either the raw receipt or a `{ value }` wrapper
  // depending on the call path; both must confirm.
  it("confirms a receipt delivered in the SDK's wrapped shape", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e060");
    const facilitator = new ExactStarknetScheme(makeSigner("0x0bede1aa"), {
      providerFactory: () => {
        const provider = mockProvider({}) as unknown as {
          getTransactionReceipt: () => Promise<unknown>;
        };
        provider.getTransactionReceipt = async () => ({
          value: {
            execution_status: "SUCCEEDED",
            finality_status: "ACCEPTED_ON_L2",
            block_number: 1000,
            events: [assetTransfer()],
          },
        });
        return provider as unknown as RpcProvider;
      },
    });

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0x0bede1aa");
  });

  it("keeps polling a receipt whose execution status is not yet an outcome", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e061");
      const facilitator = new ExactStarknetScheme(makeSigner("0x0bede1ab"), {
        providerFactory: () => {
          const provider = mockProvider({}) as unknown as {
            getTransactionReceipt: () => Promise<unknown>;
          };
          provider.getTransactionReceipt = async () => ({ finality_status: "RECEIVED" });
          return provider as unknown as RpcProvider;
        },
      });

      const pending = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);
      expect(result.transaction).toBe("0x0bede1ab");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the provider cannot be built", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e062");
    const facilitator = new ExactStarknetScheme(makeSigner("0x0bede1ad"), {
      providerFactory: () => {
        throw new Error("no rpc configured for this network: secret");
      },
    });

    const verified = await facilitator.verify(payload, requirements);
    expect(verified.isValid).toBe(false);
    expect(verified.invalidReason).toBe("unexpected_verify_error");
    expect(verified.invalidMessage).not.toContain("secret");

    const settled = await facilitator.settle(payload, requirements);
    expect(settled.success).toBe(false);
    expect(settled.errorReason).toBe("unexpected_settle_error");
    expect(settled.errorMessage).not.toContain("secret");
    expect(settled.transaction).toBe("");
  });
});

// ---------------------------------------------------------------------------
// settle() - pending store boundaries
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.settle() - pending store boundaries", () => {
  /** A store that counts reads and can be told to fail them. */
  function countingStore(fail?: "get"): PendingSettlementStore & { gets: number; fail?: "get" } {
    const inner = new InMemoryPendingSettlementStore();
    const store = {
      gets: 0,
      fail,
      async get(key: string) {
        store.gets += 1;
        if (store.fail === "get") throw new Error("redis down");
        return inner.get(key);
      },
      async set(key: string, tx: string) {
        return inner.set(key, tx);
      },
      async delete(key: string) {
        return inner.delete(key);
      },
    };
    return store;
  }

  it("never consults the store for typed data signed for a different chain", async () => {
    const requirements = buildRequirements();
    const typedData = buildCanonicalOutsideExecutionTypedData(
      "0x534e5f4d41494e", // SN_MAIN
      buildMessage("0x5711e070"),
    );
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: { from: FROM, outsideExecution: { typedData, signature: ["0x1a2b", "0x3c4d"] } },
    };
    const store = countingStore();
    const facilitator = new ExactStarknetScheme(makeSigner("0x0f1005720"), {
      providerFactory: () => mockProvider({}),
      pendingSettlementStore: store,
    });

    const result = await facilitator.settle(payload, requirements);
    expect(result.errorReason).toBe("invalid_network");
    expect(store.gets).toBe(0);
  });

  it("never consults the store for typed data that does not parse", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e071");
    (payload.payload as { outsideExecution: { typedData: unknown } }).outsideExecution.typedData = {
      message: {},
    };
    const store = countingStore();
    const facilitator = new ExactStarknetScheme(makeSigner("0x0f1005721"), {
      providerFactory: () => mockProvider({}),
      pendingSettlementStore: store,
    });

    const result = await facilitator.settle(payload, requirements);
    expect(result.errorReason).toBe("invalid_payload");
    expect(store.gets).toBe(0);
  });

  it("fails closed, without a hash, when the store cannot be read", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements, "0x5711e072");
    let broadcasts = 0;
    const signer: FacilitatorStarknetSigner = {
      getAddresses: () => [FEE_PAYER],
      executeFromOutside: async () => {
        broadcasts += 1;
        return { transactionHash: "0x0f1005722" };
      },
    };
    const facilitator = new ExactStarknetScheme(signer, {
      providerFactory: () => mockProvider({}),
      pendingSettlementStore: countingStore("get"),
    });

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("unexpected_settle_error");
    expect(result.transaction).toBe("");
    expect(result.errorMessage).not.toContain("redis");
    // Nothing was broadcast: a store that cannot be read cannot rule out a
    // remembered broadcast for this authorization.
    expect(broadcasts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Confirmation timeout option
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme - confirmationTimeoutMs", () => {
  it("rejects a non-positive or fractional confirmation timeout at construction", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(
        () =>
          new ExactStarknetScheme(makeSigner(), {
            providerFactory: () => mockProvider({}),
            confirmationTimeoutMs: bad,
          }),
      ).toThrow(/confirmationTimeoutMs/);
    }
  });

  it("bounds the receipt wait by the configured timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      const requirements = buildRequirements();
      const payload = buildPayload(requirements, "0x5711e080");
      let receiptReads = 0;
      const facilitator = new ExactStarknetScheme(makeSigner("0x0bede280"), {
        providerFactory: () => {
          const provider = mockProvider({}) as unknown as {
            getTransactionReceipt: () => Promise<unknown>;
          };
          provider.getTransactionReceipt = async () => {
            receiptReads += 1;
            throw new Error("not indexed yet");
          };
          return provider as unknown as RpcProvider;
        },
        confirmationTimeoutMs: 5_000,
      });

      const pending = facilitator.settle(payload, requirements);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.errorReason).toBe(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING);
      expect(result.transaction).toBe("0x0bede280");
      // 5 s at a 1.5 s poll interval: reads at 0, 1.5, 3, 4.5 and the one past
      // the deadline at 6 s.
      expect(receiptReads).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
