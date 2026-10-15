/**
 * Facilitator SETTLE on a real MainNet prepared transaction, with a stubbed
 * signer: success only on commit, `settlement_pending` when the relay's outcome
 * is unknown, and reconciliation of a retried payload against the earlier relay
 * instead of a second submission.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { InMemoryPendingSettlementStore } from "@x402/core/facilitator";
import { ExactCantonScheme } from "../../src/exact/facilitator/scheme.js";
import { encodeInlinePaymentPayload } from "../../src/inline-payload.js";
import { decodePrepared } from "../../src/prepared-transfer.js";
import { SubmissionOutcomeUnknownError } from "../../src/ledger/transfer-factory.js";
import { CantonError } from "../../src/ledger/client.js";
import type { FacilitatorCantonSigner, SubmissionLookup } from "../../src/signer.js";

const FIX = fileURLToPath(new URL("../../src/__fixtures__/", import.meta.url));
const CC_RAW = readFileSync(FIX + "mainnet-transfer-preapproval-0.1.21.b64", "utf8").trim();
const CC = JSON.parse(readFileSync(FIX + "mainnet-0.1.21.json", "utf8")).transfer as {
  sender: string;
  receiver: string;
  instrumentId: { admin: string; id: string };
};
const FAC = "facilitator::1220" + "ff".repeat(32);
const NETWORK = "canton:mainnet" as const;
const HASH = "ab".repeat(32);

const PREPARED_AT_MS = Number(decodePrepared(CC_RAW).preparationTime! / 1000n) + 1000;
/** The fixture's signed deadline: its executeBefore and max ledger time. */
const DEADLINE_MS = Number(decodePrepared(CC_RAW).maxLedgerEffectiveTime! / 1000n);
const TOLERANCE_MS = 10_000;
/** Past the deadline plus tolerance, yet inside the in-memory store's 5-minute TTL. */
const AFTER_FINAL_MS = DEADLINE_MS + TOLERANCE_MS + 1_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PREPARED_AT_MS);
});
afterEach(() => vi.useRealTimers());

/**
 * The fixture as an inline payload claiming `hash`.
 *
 * @param hash - The claimed prepared-transaction hash.
 * @returns The payment payload.
 */
function payload(hash = HASH): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "exact", network: NETWORK } as never,
    payload: {
      ...encodeInlinePaymentPayload({
        preparedTransactionBytes: Buffer.from(CC_RAW, "base64"),
        preparedTxHash: hash,
        signatureB64: Buffer.alloc(64, 7).toString("base64"),
      }),
    },
  };
}

const reqs: PaymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  amount: "100000000",
  asset: "CC",
  payTo: CC.receiver,
  maxTimeoutSeconds: 60,
  extra: {
    assetTransferMethod: "transfer-factory",
    feePayer: FAC,
    instrumentId: CC.instrumentId,
    executeBeforeSeconds: 120,
  },
};

/** A signer whose signature check authenticates the claimed hash, as the real
 *  one does when the bytes hash to it. */
function signer(over: Partial<FacilitatorCantonSigner> = {}) {
  const executed: string[] = [];
  const s: FacilitatorCantonSigner = {
    getAddresses: () => [FAC],
    verifySignature: async args => ({
      verified: true,
      preparedTxHashHex: args.claimedPreparedTxHash,
    }),
    executeSubmission: async args => {
      executed.push(args.submissionId);
      return { updateId: "1220-settled" };
    },
    lookupSubmission: async () => ({ status: "absent" }),
    ...over,
  };
  return { s, executed };
}

const unknownOutcome = async (): Promise<never> => {
  throw new SubmissionOutcomeUnknownError(new Error("timed out"), 77);
};

describe("settle", () => {
  it("succeeds with the committed updateId under a submission id derived from the hash", async () => {
    const { s, executed } = signer();
    const r = await new ExactCantonScheme(s, { networks: [NETWORK] }).settle(payload(), reqs);
    expect(r).toMatchObject({ success: true, transaction: "1220-settled", payer: CC.sender });
    expect(executed).toEqual([`x402-settle-${HASH}`]);
  });

  it("a definite refusal is the retryable execute failure", async () => {
    const { s } = signer({
      executeSubmission: async () => {
        throw new Error("SUBMISSION_FAILED");
      },
    });
    const r = await new ExactCantonScheme(s, { networks: [NETWORK] }).settle(payload(), reqs);
    expect(r).toMatchObject({ success: false, errorReason: "invalid_exact_canton_execute_failed" });
  });

  it("a refusal on the facilitator's side (credentials, rate limit) is a ledger error", async () => {
    for (const status of [401, 403, 404, 429]) {
      const { s } = signer({
        executeSubmission: async () => {
          throw new CantonError(`HTTP ${status}`, "HTTP_ERROR", status);
        },
      });
      const r = await new ExactCantonScheme(s, { networks: [NETWORK] }).settle(payload(), reqs);
      expect(r.errorReason).toBe("unexpected_canton_ledger_error");
    }
  });

  it("does not relay a payload that fails verification", async () => {
    const { s, executed } = signer({ verifySignature: async () => ({ verified: false }) });
    const r = await new ExactCantonScheme(s, { networks: [NETWORK] }).settle(payload(), reqs);
    expect(r.errorReason).toBe("invalid_exact_canton_signature_invalid");
    expect(executed).toHaveLength(0);
  });

  it("an unknown outcome is settlement_pending, keyed and identified by the hash", async () => {
    const store = new InMemoryPendingSettlementStore();
    const { s } = signer({ executeSubmission: unknownOutcome });
    const r = await new ExactCantonScheme(s, {
      networks: [NETWORK],
      pendingSettlementStore: store,
      ledgerTimeToleranceMs: TOLERANCE_MS,
    }).settle(payload(), reqs);
    expect(r).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
      transaction: HASH,
      network: NETWORK,
      payer: CC.sender,
    });
    const record = JSON.parse((await store.get(HASH))!);
    expect(record).toMatchObject({ submissionId: `x402-settle-${HASH}`, beginOffset: 77 });
    expect(typeof record.commandId).toBe("string");
  });

  it("stays pending when the relay cannot be remembered", async () => {
    const { s } = signer({ executeSubmission: unknownOutcome });
    const failing = {
      get: async () => undefined,
      set: async () => {
        throw new Error("store down");
      },
      delete: async () => undefined,
    };
    const r = await new ExactCantonScheme(s, {
      networks: [NETWORK],
      pendingSettlementStore: failing,
    }).settle(payload(), reqs);
    expect(r.errorReason).toBe("settlement_pending");
  });
});

describe("settle retry after settlement_pending", () => {
  /**
   * Leave a pending relay in a store, then retry with the given lookup result.
   *
   * @param lookup - What the ledger says about the relay on retry.
   * @param retryAtMs - When the retry happens.
   * @returns The retry's response, the store, and the second relay attempts.
   */
  async function retry(lookup: SubmissionLookup, retryAtMs = PREPARED_AT_MS + 5_000) {
    const store = new InMemoryPendingSettlementStore();
    const first = signer({ executeSubmission: unknownOutcome });
    await new ExactCantonScheme(first.s, {
      networks: [NETWORK],
      pendingSettlementStore: store,
      ledgerTimeToleranceMs: TOLERANCE_MS,
    }).settle(payload(), reqs);
    vi.setSystemTime(retryAtMs);
    const lookups: unknown[] = [];
    const second = signer({
      lookupSubmission: async args => {
        lookups.push(args);
        return lookup;
      },
    });
    const r = await new ExactCantonScheme(second.s, {
      networks: [NETWORK],
      pendingSettlementStore: store,
      ledgerTimeToleranceMs: TOLERANCE_MS,
    }).settle(payload(), reqs);
    return { r, store, executed: second.executed, lookups };
  }

  it("a committed relay settles without a second submission", async () => {
    const { r, store, executed, lookups } = await retry({
      status: "committed",
      updateId: "1220-c",
    });
    expect(r).toMatchObject({ success: true, transaction: "1220-c" });
    expect(executed).toHaveLength(0);
    expect(lookups).toEqual([
      expect.objectContaining({
        payer: CC.sender,
        submissionId: `x402-settle-${HASH}`,
        beginOffset: 77,
      }),
    ]);
    expect(JSON.parse((await store.get(HASH))!)).toMatchObject({
      kind: "settled",
      updateId: "1220-c",
    });
  });

  it("reconciles even after the transfer's executeBefore has passed", async () => {
    const { r } = await retry({ status: "committed", updateId: "1220-c" }, DEADLINE_MS + 1_000);
    expect(r).toMatchObject({ success: true, transaction: "1220-c" });
  });

  it("a rejected relay is a final execute failure", async () => {
    const { r, store } = await retry({ status: "rejected" });
    expect(r.errorReason).toBe("invalid_exact_canton_execute_failed");
    expect(await store.get(HASH)).toBeUndefined();
  });

  it("an absent relay before its deadline stays pending", async () => {
    const { r, store, executed } = await retry(
      { status: "absent" },
      DEADLINE_MS + TOLERANCE_MS - 1_000,
    );
    expect(r.errorReason).toBe("settlement_pending");
    expect(await store.get(HASH)).toBeDefined();
    expect(executed).toHaveLength(0);
  });

  it("an absent relay past its deadline can never commit: final failure", async () => {
    const { r, store } = await retry({ status: "absent" }, AFTER_FINAL_MS);
    expect(r.errorReason).toBe("invalid_exact_canton_execute_failed");
    expect(await store.get(HASH)).toBeUndefined();
  });

  it("an unreadable ledger stays pending, even past the deadline", async () => {
    const { r } = await retry({ status: "unknown" }, AFTER_FINAL_MS);
    expect(r.errorReason).toBe("settlement_pending");
  });

  it("a different payload claiming the same hash does not take over the pending relay", async () => {
    const store = new InMemoryPendingSettlementStore();
    const first = signer({ executeSubmission: unknownOutcome });
    await new ExactCantonScheme(first.s, {
      networks: [NETWORK],
      pendingSettlementStore: store,
      ledgerTimeToleranceMs: TOLERANCE_MS,
    }).settle(payload(), reqs);
    // The bytes are the same, but the signature does not authenticate the hash.
    const { s, executed } = signer({
      verifySignature: async () => ({ verified: true, preparedTxHashHex: "ef".repeat(32) }),
      lookupSubmission: async () => ({ status: "committed", updateId: "1220-someone-else" }),
    });
    const r = await new ExactCantonScheme(s, {
      networks: [NETWORK],
      pendingSettlementStore: store,
      ledgerTimeToleranceMs: TOLERANCE_MS,
    }).settle(payload(), reqs);
    expect(r.transaction).not.toBe("1220-someone-else");
    expect(executed).toHaveLength(1);
    expect(await store.get(HASH)).toBeDefined();
  });

  it("a duplicate relay never becomes a final failure, even past the deadline", async () => {
    const store = new InMemoryPendingSettlementStore();
    const first = signer({
      executeSubmission: async () => {
        throw new SubmissionOutcomeUnknownError(new Error("409"), 900, true);
      },
    });
    const scheme = (s: FacilitatorCantonSigner) =>
      new ExactCantonScheme(s, {
        networks: [NETWORK],
        pendingSettlementStore: store,
        ledgerTimeToleranceMs: TOLERANCE_MS,
      });
    expect((await scheme(first.s).settle(payload(), reqs)).errorReason).toBe("settlement_pending");
    expect(JSON.parse((await store.get(HASH))!)).toMatchObject({ duplicate: true });
    vi.setSystemTime(AFTER_FINAL_MS);
    const second = signer({ lookupSubmission: async () => ({ status: "absent" }) });
    expect((await scheme(second.s).settle(payload(), reqs)).errorReason).toBe("settlement_pending");
  });

  it("answers a retry after a lost success response from memory, without relaying again", async () => {
    const store = new InMemoryPendingSettlementStore();
    const first = signer();
    const opts = { networks: [NETWORK], pendingSettlementStore: store };
    expect((await new ExactCantonScheme(first.s, opts).settle(payload(), reqs)).success).toBe(true);
    const second = signer();
    const r = await new ExactCantonScheme(second.s, opts).settle(payload(), reqs);
    expect(r).toMatchObject({ success: true, transaction: "1220-settled" });
    expect(second.executed).toHaveLength(0);
  });

  it("stays pending when the retry cannot re-verify for a ledger read failure", async () => {
    const store = new InMemoryPendingSettlementStore();
    const first = signer({ executeSubmission: unknownOutcome });
    const opts = { networks: [NETWORK], pendingSettlementStore: store };
    await new ExactCantonScheme(first.s, opts).settle(payload(), reqs);
    const second = signer({
      verifySignature: async () => {
        throw new Error("topology unavailable");
      },
    });
    const r = await new ExactCantonScheme(second.s, opts).settle(payload(), reqs);
    expect(r).toMatchObject({ errorReason: "settlement_pending", transaction: HASH });
    expect(second.executed).toHaveLength(0);
  });

  it("ignores a store entry that is not a pending record", async () => {
    const store = new InMemoryPendingSettlementStore();
    await store.set(HASH, "not json");
    const { s, executed } = signer();
    const r = await new ExactCantonScheme(s, {
      networks: [NETWORK],
      pendingSettlementStore: store,
      ledgerTimeToleranceMs: TOLERANCE_MS,
    }).settle(payload(), reqs);
    expect(r.success).toBe(true);
    expect(executed).toHaveLength(1);
  });
});
