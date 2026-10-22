import * as cardano from "@x402/cardano";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyPaymentResponse,
  CONFIG_REASONS,
  type LockRunner,
  MAX_SENDS_PER_HEADER,
  PaymentController,
  paymentRecordKey,
  type PaymentRecord,
  REQS_CHANGED_REASON,
  RESIGN_LOCKOUT_AFTER_TTL_MS,
  type SignedPayment,
  STATE_REASONS,
  STATIC_REASONS,
  type StorageLike,
  TRANSIENT_REASONS,
  webLocksRunner,
} from "./payment";

const URL = "https://api.example.com/premium";
const NONCE_A = `${"a".repeat(64)}#0`;
const NONCE_B = `${"b".repeat(64)}#1`;
const NONCE_Z = `${"f".repeat(64)}#9`;
const REQ: PaymentRequirements = {
  scheme: "exact",
  network: "cardano:preprod",
  asset: "lovelace",
  amount: "2000000",
  payTo: "addr_test1qpayee",
  maxTimeoutSeconds: 600,
  extra: {},
};

/** In-memory storage. */
class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

const verify402 = (reason: string): Response =>
  new Response("{}", {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
        x402Version: 2,
        error: reason,
        resource: { url: URL },
        accepts: [REQ],
      }),
    },
  });

const settle402 = (reason: string, transaction = "tx-from-server"): Response =>
  new Response("{}", {
    status: 402,
    headers: {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({
        success: false,
        errorReason: reason,
        transaction,
        network: "cardano:preprod",
      }),
    },
  });

const ok = (): Response =>
  new Response("content", {
    status: 200,
    headers: {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({
        success: true,
        transaction: "tx-from-server",
        network: "cardano:preprod",
      }),
    },
  });

const passthroughLock: LockRunner = (_name, fn) => fn();

let now: number;
let storage: MemoryStorage;
let signCalls: Array<string | undefined>;
let sentHeaders: string[];
let responses: Array<Response | undefined | "hang">;
let signImpl: (pinned: string | undefined) => Promise<SignedPayment>;

beforeEach(() => {
  now = 1_000_000;
  storage = new MemoryStorage();
  signCalls = [];
  sentHeaders = [];
  responses = [];
  signImpl = async pinned => ({
    header: `header-${signCalls.length}`,
    nonce: pinned ?? NONCE_A,
    txId: `tx-${signCalls.length}`,
    ttlMs: now + 510_000,
  });
});

/**
 * Creates a controller over the shared test state.
 *
 * @param overrides - Dependency overrides.
 * @returns Controller.
 */
function controller(overrides: Partial<ConstructorParameters<typeof PaymentController>[0]> = {}) {
  return new PaymentController({
    resourceUrl: URL,
    requirement: REQ,
    storage,
    clock: { now: () => now },
    lock: passthroughLock,
    sign: async pinned => {
      signCalls.push(pinned);
      return signImpl(pinned);
    },
    send: async header => {
      sentHeaders.push(header);
      const next = responses.shift();
      if (next === "hang") return new Promise<Response | undefined>(() => {});
      return next;
    },
    ...overrides,
  });
}

/**
 * Reads the stored record.
 *
 * @param req - Requirement used for the key.
 * @returns The record.
 */
function stored(req: PaymentRequirements = REQ): PaymentRecord | undefined {
  const raw = storage.getItem(paymentRecordKey(URL, req));
  return raw ? (JSON.parse(raw) as PaymentRecord) : undefined;
}

describe("classifyPaymentResponse", () => {
  it.each([...STATIC_REASONS])("verify 402 %s → STATIC", reason => {
    expect(classifyPaymentResponse(verify402(reason))).toEqual({ cls: "STATIC", reason });
  });
  it.each([...STATE_REASONS])("verify 402 %s → STATE", reason => {
    expect(classifyPaymentResponse(verify402(reason)).cls).toBe("STATE");
  });
  it.each([...TRANSIENT_REASONS])("verify 402 %s → TRANSIENT", reason => {
    expect(classifyPaymentResponse(verify402(reason)).cls).toBe("TRANSIENT");
  });
  it.each([...CONFIG_REASONS])("verify 402 %s → CONFIG", reason => {
    expect(classifyPaymentResponse(verify402(reason)).cls).toBe("CONFIG");
  });

  it("classifies requirement changes, success and everything else as ambiguous", () => {
    expect(classifyPaymentResponse(verify402(REQS_CHANGED_REASON)).cls).toBe("REQS_CHANGED");
    expect(classifyPaymentResponse(ok())).toEqual({ cls: "SUCCESS" });
    expect(classifyPaymentResponse(new Response("x"))).toEqual({ cls: "SUCCESS" });
    expect(classifyPaymentResponse(undefined).cls).toBe("AMBIGUOUS");
    expect(classifyPaymentResponse(new Response("{}", { status: 402 })).cls).toBe("AMBIGUOUS");
    expect(classifyPaymentResponse(new Response("{}", { status: 502 })).cls).toBe("AMBIGUOUS");
    expect(classifyPaymentResponse(verify402("Payment verification failed")).cls).toBe("AMBIGUOUS");
    expect(
      classifyPaymentResponse(verify402("invalid_exact_cardano_payload_masumi_new_thing")).cls,
    ).toBe("AMBIGUOUS");
    const settle = classifyPaymentResponse(settle402(cardano.ERR_SETTLEMENT_PENDING));
    expect(settle).toEqual({ cls: "AMBIGUOUS", reason: cardano.ERR_SETTLEMENT_PENDING });
    const both = verify402(cardano.ERR_RECIPIENT_MISMATCH);
    both.headers.set(
      "PAYMENT-RESPONSE",
      settle402("unexpected_settle_error").headers.get("PAYMENT-RESPONSE")!,
    );
    expect(classifyPaymentResponse(both).cls).toBe("AMBIGUOUS");
  });

  it("treats undecodable headers as ambiguous", () => {
    const badRequired = new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": "%%%" } });
    expect(classifyPaymentResponse(badRequired).cls).toBe("AMBIGUOUS");
    const noError = new Response("{}", {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
          x402Version: 2,
          accepts: [REQ],
        } as never),
      },
    });
    expect(classifyPaymentResponse(noError).cls).toBe("AMBIGUOUS");
    const badSettle = new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": "%%%" } });
    expect(classifyPaymentResponse(badSettle).cls).toBe("AMBIGUOUS");
  });

  it("only lists reason codes that @x402/cardano actually exports", () => {
    const exported = new Set<string>(
      Object.values(cardano as Record<string, unknown>).filter(
        (v: unknown): v is string => typeof v === "string",
      ),
    );
    const inline = `${cardano.ERR_INVALID_PAYLOAD}_unsupported_version`;
    for (const list of [STATIC_REASONS, STATE_REASONS, TRANSIENT_REASONS, CONFIG_REASONS]) {
      for (const reason of list) {
        expect(exported.has(reason) || reason === inline, reason).toBe(true);
      }
    }
  });
});

describe("PaymentController", () => {
  it("keeps a settled record until delivery is confirmed, then forgets it", async () => {
    responses = [ok()];
    const c = controller();
    expect((await c.pay()).kind).toBe("success");
    expect(stored()?.lastClass).toBe("SUCCESS");
    await c.completeDelivery();
    expect(stored()).toBeUndefined();
    expect(signCalls).toEqual([undefined]);
  });

  it("never signs again when the paid content failed to load", async () => {
    responses = [ok()];
    const c = controller();
    await c.pay();
    // The page crashed reading the body: completeDelivery() was never called.
    const reloaded = controller();
    expect(reloaded.view()).toEqual({ kind: "settled", txId: "tx-1" });
    expect(await reloaded.pay()).toEqual({ kind: "settled", txId: "tx-1" });
    responses = [ok()];
    expect((await reloaded.checkAgain()).kind).toBe("success");
    expect(sentHeaders).toEqual(["header-1", "header-1"]);
    expect(signCalls).toHaveLength(1);
    expect(await reloaded.discard(true)).toEqual({ kind: "ready" });
  });

  it("stays settled whatever a content-collecting resend gets back", async () => {
    responses = [ok()];
    await controller().pay();
    responses = [verify402(cardano.ERR_NONCE_NOT_ON_CHAIN)];
    const c = controller();
    expect(await c.checkAgain()).toEqual({ kind: "settled", txId: "tx-1" });
    expect(stored()?.header).toBe("header-1");
    expect(await c.pay()).toEqual({ kind: "settled", txId: "tx-1" });
    // A resend whose answer is lost (reload mid-request) keeps it settled too.
    responses = ["hang"];
    void controller().checkAgain();
    await vi.waitFor(() => expect(sentHeaders).toHaveLength(3));
    expect(controller().view()).toEqual({ kind: "settled", txId: "tx-1" });
    expect(signCalls).toHaveLength(1);
  });

  it("finds the same record when the server switches between CIP-34 alias and canonical id", async () => {
    responses = [settle402(cardano.ERR_SETTLEMENT_PENDING)];
    await controller().pay();
    const alias = { ...REQ, network: "cip34:0-1" as PaymentRequirements["network"] };
    expect(paymentRecordKey(URL, alias)).toBe(paymentRecordKey(URL, REQ));
    const reloaded = controller({ requirement: alias });
    expect(reloaded.view().kind).toBe("ambiguous");
    now += 10_000;
    responses = [ok()];
    expect((await reloaded.pay()).kind).toBe("success");
    expect(sentHeaders).toEqual(["header-1", "header-1"]);
    expect(signCalls).toHaveLength(1);
  });

  it("keeps the nonce pin when the payee or asset changes after an ambiguous send", async () => {
    responses = [settle402(cardano.ERR_SETTLEMENT_PENDING)];
    await controller().pay();
    for (const changed of [
      { ...REQ, payTo: "addr_test1qotherpayee" },
      { ...REQ, asset: cardano.USDM_PREPROD_ASSET },
    ]) {
      expect(paymentRecordKey(URL, changed)).toBe(paymentRecordKey(URL, REQ));
      now += 10_000;
      responses = [verify402(REQS_CHANGED_REASON)];
      expect((await controller({ requirement: changed }).pay()).kind).not.toBe("success");
    }
    expect(signCalls).toHaveLength(1);
    expect(new Set(sentHeaders)).toEqual(new Set(["header-1"]));
  });

  it("resends a byte-identical header after settlement_pending and signs only once", async () => {
    responses = [settle402(cardano.ERR_SETTLEMENT_PENDING), ok()];
    const c = controller();
    const first = await c.pay();
    expect(first).toMatchObject({ kind: "ambiguous", autoRetry: true, txId: "tx-1" });
    const early = await c.pay();
    expect(early.kind).toBe("ambiguous");
    expect(sentHeaders).toHaveLength(1);
    now += 10_000;
    const second = await c.pay();
    expect(second.kind).toBe("success");
    expect(sentHeaders).toEqual(["header-1", "header-1"]);
    expect(signCalls).toHaveLength(1);
  });

  it("treats a 402 carrying a settle result as possibly broadcast and resends the same header", async () => {
    responses = [settle402("unexpected_settle_error"), verify402(cardano.ERR_NONCE_NOT_ON_CHAIN)];
    const c = controller();
    expect((await c.pay()).kind).toBe("ambiguous");
    now += 10_000;
    const after = await c.pay();
    expect(after.kind).toBe("ambiguous");
    expect(sentHeaders).toEqual(["header-1", "header-1"]);
    expect(signCalls).toHaveLength(1);
    expect(stored()?.possiblyBroadcast).toBe(true);
  });

  it("never re-signs before TTL + lockout after a possible broadcast; then a missing nonce is UNRESOLVED", async () => {
    responses = [settle402("unexpected_settle_error")];
    const c = controller();
    await c.pay();
    const ttl = stored()!.ttlMs;
    for (let i = 1; i < MAX_SENDS_PER_HEADER; i++) {
      now += 10_000;
      responses.push(verify402(cardano.ERR_NONCE_NOT_ON_CHAIN));
      await c.pay();
    }
    expect(sentHeaders).toHaveLength(MAX_SENDS_PER_HEADER);
    const capped = await c.pay();
    expect(capped).toMatchObject({ kind: "unresolved", unlocked: false });
    expect(sentHeaders).toHaveLength(MAX_SENDS_PER_HEADER);
    expect(signCalls).toHaveLength(1);

    now = ttl + RESIGN_LOCKOUT_AFTER_TTL_MS;
    signImpl = async () => {
      throw Object.assign(new Error("gone"), { code: "pinned_nonce_missing" });
    };
    // A status check past the lockout never signs …
    expect(await c.pay()).toMatchObject({ kind: "unresolved", unlocked: true });
    expect(signCalls).toEqual([undefined]);
    // … only the explicit "try again with the same funds" does.
    const after = await c.resign();
    expect(after).toMatchObject({ kind: "unresolved", unlocked: true });
    expect(signCalls).toEqual([undefined, NONCE_A]);
  });

  it("re-signs with the same nonce after a definite pre-broadcast rejection", async () => {
    responses = [verify402(cardano.ERR_FEE_BELOW_MINIMUM), ok()];
    const c = controller();
    expect(await c.pay()).toMatchObject({
      kind: "rejected",
      reason: cardano.ERR_FEE_BELOW_MINIMUM,
    });
    expect(stored()?.header).toBeUndefined();
    expect((await c.pay()).kind).toBe("success");
    expect(signCalls).toEqual([undefined, NONCE_A]);
  });

  it("asks about the wallet's network instead of re-signing on a verify-only missing nonce", async () => {
    responses = [verify402(cardano.ERR_NONCE_NOT_ON_CHAIN), ok()];
    const c = controller();
    expect((await c.pay()).kind).toBe("wrong_network");
    expect(signCalls).toHaveLength(1);
    expect((await c.pay()).kind).toBe("success");
    expect(signCalls).toEqual([undefined, NONCE_A]);
  });

  it("resumes after a reload mid-request by resending the same header", async () => {
    responses = ["hang"];
    void controller().pay();
    await vi.waitFor(() => expect(sentHeaders).toHaveLength(1));
    const reloaded = controller();
    expect(reloaded.view().kind).toBe("ambiguous");
    now += 10_000;
    responses = [ok()];
    expect((await reloaded.pay()).kind).toBe("success");
    expect(sentHeaders).toEqual(["header-1", "header-1"]);
    expect(signCalls).toHaveLength(1);
  });

  it("keeps the pinned record across a price change and reloads at most once", async () => {
    responses = [verify402(REQS_CHANGED_REASON)];
    expect((await controller().pay()).kind).toBe("reload");
    const newPrice = { ...REQ, amount: "3000000" };
    expect(paymentRecordKey(URL, newPrice)).toBe(paymentRecordKey(URL, REQ));
    responses = [verify402(REQS_CHANGED_REASON)];
    const after = await controller({ requirement: newPrice }).pay();
    expect(after.kind).toBe("unresolved");
    expect(signCalls).toEqual([undefined, NONCE_A]);
  });

  it("applies the lockout when requirements change after a possible broadcast", async () => {
    responses = [settle402("x"), verify402(REQS_CHANGED_REASON)];
    const c = controller();
    await c.pay();
    now += 10_000;
    expect((await c.pay()).kind).toBe("ambiguous");
    expect(signCalls).toHaveLength(1);
  });

  it("goes UNRESOLVED on a fresh page whose pinned nonce disappeared after a send", async () => {
    responses = [undefined];
    await controller().pay();
    const ttl = stored()!.ttlMs;
    now = ttl + RESIGN_LOCKOUT_AFTER_TTL_MS + 1;
    signImpl = async () => {
      throw Object.assign(new Error("gone"), { code: "pinned_nonce_missing" });
    };
    const fresh = controller();
    expect((await fresh.pay()).kind).toBe("unresolved");
    expect(sentHeaders).toHaveLength(1);
  });

  it("starts over with fresh funds when a never-sent record's nonce disappeared", async () => {
    signImpl = async pinned => {
      if (pinned) throw Object.assign(new Error("gone"), { code: "pinned_nonce_missing" });
      return { header: "h", nonce: NONCE_B, txId: "t", ttlMs: now + 510_000 };
    };
    storage.setItem(
      paymentRecordKey(URL, REQ),
      JSON.stringify({
        v: 1,
        version: 1,
        nonce: NONCE_A,
        ttlMs: now + 510_000,
        requirement: REQ,
        sendCount: 0,
        totalSends: 0,
        signCount: 1,
        possiblyBroadcast: false,
        reqsReloaded: false,
        verifyOnlyRejections: true,
        lastClass: "STATIC",
        expiresAt: now + 10_000_000,
      }),
    );
    responses = [ok()];
    expect((await controller().pay()).kind).toBe("success");
    expect(signCalls).toEqual([NONCE_A, undefined]);
  });

  it("serialises two tabs sharing a lock so the write-ahead count stays consistent", async () => {
    let tail: Promise<unknown> = Promise.resolve();
    const shared: LockRunner = <T>(_n: string, fn: () => Promise<T>) => {
      const run = tail.then(fn, fn);
      tail = run.catch(() => undefined);
      return run;
    };
    responses = [settle402(cardano.ERR_SETTLEMENT_PENDING)];
    const [a, b] = [controller({ lock: shared }), controller({ lock: shared })];
    await Promise.all([a.pay(), b.pay()]);
    expect(sentHeaders).toEqual(["header-1"]);
    expect(stored()?.sendCount).toBe(1);
    expect(signCalls).toHaveLength(1);
  });

  it("refuses to sign without working storage", async () => {
    const broken: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    const c = controller({ storage: broken });
    expect(c.view()).toEqual({ kind: "terminal", reason: "storage_unavailable" });
    expect(await c.pay()).toEqual({ kind: "terminal", reason: "storage_unavailable" });
    expect(await c.checkAgain()).toEqual({ kind: "terminal", reason: "storage_unavailable" });
    expect(signCalls).toHaveLength(0);
  });

  it("stops on a misconfigured merchant: terminal, no further signature, reset only by acknowledgement", async () => {
    responses = [verify402(cardano.ERR_EVIDENCE_UNAVAILABLE)];
    const c = controller();
    const terminal = { kind: "terminal", reason: "merchant_misconfigured" };
    expect(await c.pay()).toEqual(terminal);
    expect(await c.pay()).toEqual(terminal);
    expect(await c.checkAgain()).toEqual(terminal);
    expect(controller().view()).toEqual(terminal);
    expect(signCalls).toHaveLength(1);
    expect(sentHeaders).toHaveLength(1);
    // A sent header keeps the lockout before the record may be reset.
    expect((await c.discard(true)).kind).toBe("unresolved");
    now = stored()!.ttlMs + RESIGN_LOCKOUT_AFTER_TTL_MS;
    expect(await c.discard(true)).toEqual({ kind: "ready" });
  });

  it("keeps a settled payment loadable when a content resend is answered with CONFIG", async () => {
    responses = [ok()];
    await controller().pay();
    responses = [verify402(cardano.ERR_EVIDENCE_UNAVAILABLE)];
    const c = controller();
    expect(await c.checkAgain()).toEqual({ kind: "settled", txId: "tx-1" });
    expect(c.view()).toEqual({ kind: "settled", txId: "tx-1" });
    responses = [ok()];
    expect((await c.checkAgain()).kind).toBe("success");
    expect(signCalls).toHaveLength(1);
  });

  it("keeps CONFIG terminal after an earlier ambiguous answer, even past the lockout", async () => {
    responses = [settle402(cardano.ERR_SETTLEMENT_PENDING)];
    const c = controller();
    await c.pay();
    now += 10_000;
    responses = [verify402(cardano.ERR_EVIDENCE_UNAVAILABLE)];
    // The earlier answer was ambiguous: the page must say it may have paid.
    const terminal = {
      kind: "terminal",
      reason: "merchant_misconfigured",
      possiblyPaid: true,
      txId: "tx-1",
    };
    expect(await c.pay()).toEqual(terminal);
    expect(stored()?.header).toBe("header-1");
    now = stored()!.ttlMs + RESIGN_LOCKOUT_AFTER_TTL_MS + 1;
    expect(await c.pay()).toEqual(terminal);
    expect(await c.checkAgain()).toEqual(terminal);
    expect(controller().view()).toEqual(terminal);
    expect(signCalls).toHaveLength(1);
    expect(sentHeaders).toHaveLength(2);
  });

  it("never purges a record because the server clock runs ahead of the device", async () => {
    now = Date.now();
    responses = [undefined];
    await controller().pay();
    const record = stored()!;
    now = record.expiresAt + 48 * 60 * 60_000;
    expect(controller().view().kind).toBe("unresolved");
    expect(stored()?.nonce).toBe(NONCE_A);
  });

  it("shows unresolved, not 'nothing charged', when a re-sign after the lockout fails", async () => {
    responses = [undefined];
    const c = controller();
    await c.pay();
    now = stored()!.ttlMs + RESIGN_LOCKOUT_AFTER_TTL_MS;
    signImpl = async () => {
      throw new Error("user declined");
    };
    await expect(c.resign()).rejects.toThrow("user declined");
    const view = c.view();
    // The original payment is kept, so it can still be re-checked.
    expect(view).toMatchObject({ kind: "unresolved", unlocked: true, canCheckAgain: true });
    expect(stored()?.header).toBe("header-1");
    expect(stored()?.nonce).toBe(NONCE_A);
    responses = [ok()];
    expect((await c.checkAgain()).kind).toBe("success");
    expect(sentHeaders).toEqual(["header-1", "header-1"]);
  });

  it("keeps the original payment when a re-sign finds the pinned funds already spent", async () => {
    responses = [settle402(cardano.ERR_SETTLEMENT_PENDING)];
    const c = controller();
    await c.pay();
    now = stored()!.ttlMs + RESIGN_LOCKOUT_AFTER_TTL_MS;
    signImpl = async () => {
      throw Object.assign(new Error("gone"), { code: "pinned_nonce_missing" });
    };
    expect(await c.resign()).toMatchObject({ kind: "unresolved", canCheckAgain: true });
    expect(stored()?.header).toBe("header-1");
    expect(stored()?.possiblyBroadcast).toBe(true);
  });

  it("keeps the original payment when a re-signed transaction is already too late to send", async () => {
    responses = [undefined];
    const c = controller();
    await c.pay();
    now = stored()!.ttlMs + RESIGN_LOCKOUT_AFTER_TTL_MS;
    signImpl = async pinned => ({
      header: "late",
      nonce: pinned!,
      txId: "t2",
      ttlMs: now + 10_000,
    });
    // The page returns to the original payment's status view, with Check again.
    expect(await c.resign()).toMatchObject({
      kind: "unresolved",
      unlocked: true,
      canCheckAgain: true,
    });
    expect(stored()?.header).toBe("header-1");
    expect(sentHeaders).toEqual(["header-1"]);
  });

  it("resends the same header after a transient lookup failure", async () => {
    responses = [verify402(cardano.ERR_CHAIN_LOOKUP_FAILED), ok()];
    const c = controller();
    expect((await c.pay()).kind).toBe("retry");
    now += 10_000;
    expect((await c.pay()).kind).toBe("success");
    expect(sentHeaders).toEqual(["header-1", "header-1"]);
  });

  it("caps signatures per record", async () => {
    responses = [
      verify402(cardano.ERR_FEE_BELOW_MINIMUM),
      verify402(cardano.ERR_FEE_BELOW_MINIMUM),
      verify402(cardano.ERR_FEE_BELOW_MINIMUM),
    ];
    const c = controller();
    for (let i = 0; i < 3; i++) await c.pay();
    expect((await c.pay()).kind).toBe("unresolved");
    expect(signCalls).toHaveLength(3);
  });

  it("re-signs instead of sending a stored header that is about to expire", async () => {
    signImpl = async pinned => ({
      header: `h${signCalls.length}`,
      nonce: pinned ?? NONCE_A,
      txId: "t",
      ttlMs: now + 50_000,
    });
    expect(await controller().pay()).toEqual({
      kind: "rejected",
      reason: "payment_window_expired",
    });
    expect(sentHeaders).toHaveLength(0);
    signImpl = async pinned => ({
      header: "fresh",
      nonce: pinned!,
      txId: "t",
      ttlMs: now + 510_000,
    });
    responses = [ok()];
    expect((await controller().pay()).kind).toBe("success");
    expect(sentHeaders).toEqual(["fresh"]);
  });

  it("sends a signed but never-sent header after a reload", async () => {
    storage.setItem(
      paymentRecordKey(URL, REQ),
      JSON.stringify({
        v: 1,
        version: 1,
        nonce: NONCE_A,
        header: "pending-header",
        ttlMs: now + 300_000,
        requirement: REQ,
        sendCount: 0,
        totalSends: 0,
        signCount: 1,
        possiblyBroadcast: false,
        reqsReloaded: false,
        verifyOnlyRejections: true,
        expiresAt: now + 10_000_000,
      }),
    );
    expect(controller().view().kind).toBe("ready");
    responses = [ok()];
    expect((await controller().pay()).kind).toBe("success");
    expect(sentHeaders).toEqual(["pending-header"]);
    expect(signCalls).toHaveLength(0);
  });

  it("propagates signing errors without touching the record", async () => {
    signImpl = async () => {
      throw new Error("user declined");
    };
    await expect(controller().pay()).rejects.toThrow("user declined");
    expect(stored()).toBeUndefined();
  });

  it("refuses a signer that spends a different nonce than the pinned one", async () => {
    responses = [verify402(cardano.ERR_FEE_BELOW_MINIMUM)];
    await controller().pay();
    signImpl = async () => ({ header: "h", nonce: NONCE_Z, txId: "t", ttlMs: now + 510_000 });
    await expect(controller().pay()).rejects.toThrow(/different nonce/);
  });

  it("allows discarding only with acknowledgement and after the lockout", async () => {
    responses = [undefined];
    const c = controller();
    await c.pay();
    expect((await c.discard(false)).kind).toBe("ambiguous");
    expect((await c.discard(true)).kind).toBe("unresolved");
    now = stored()!.ttlMs + RESIGN_LOCKOUT_AFTER_TTL_MS;
    expect(await c.discard(true)).toEqual({ kind: "ready" });
    expect(stored()).toBeUndefined();
    expect(await c.discard(true)).toEqual({ kind: "ready" });
  });

  it("lets Check again resend past the cap once unlocked, and Try again re-sign with the same nonce", async () => {
    responses = Array.from({ length: MAX_SENDS_PER_HEADER }, () => undefined);
    const c = controller();
    for (let i = 0; i < MAX_SENDS_PER_HEADER; i++) {
      await c.pay();
      now += 10_000;
    }
    expect((await c.checkAgain()).kind).toBe("unresolved");
    now = stored()!.ttlMs + RESIGN_LOCKOUT_AFTER_TTL_MS;
    responses = [undefined];
    await c.checkAgain();
    expect(sentHeaders).toHaveLength(MAX_SENDS_PER_HEADER + 1);
    // Only one extra check past the cap.
    const again = await c.checkAgain();
    expect(again).toMatchObject({ kind: "unresolved", canCheckAgain: false });
    expect(controller().view()).toMatchObject({ kind: "unresolved", canCheckAgain: false });
    expect(sentHeaders).toHaveLength(MAX_SENDS_PER_HEADER + 1);
    responses = [ok()];
    expect(await c.pay()).toMatchObject({ kind: "unresolved" });
    expect((await c.resign()).kind).toBe("success");
    expect(signCalls).toEqual([undefined, NONCE_A]);
  });

  it("resign() before the lockout only reports the unresolved state", async () => {
    responses = [settle402(cardano.ERR_SETTLEMENT_PENDING)];
    const c = controller();
    await c.pay();
    expect(await c.resign()).toMatchObject({ kind: "unresolved", unlocked: false });
    expect(signCalls).toHaveLength(1);
  });

  it("keeps sent and settled records past their expiry; only never-sent ones expire", async () => {
    responses = [verify402(cardano.ERR_RECIPIENT_MISMATCH)];
    await controller().pay();
    expect(controller().view()).toEqual({
      kind: "rejected",
      reason: cardano.ERR_RECIPIENT_MISMATCH,
    });
    now = stored()!.expiresAt + 48 * 60 * 60_000;
    expect(controller().view().kind).toBe("rejected");
    expect(stored()).toBeDefined();

    storage.clear();
    responses = [ok()];
    await controller().pay();
    now = stored()!.expiresAt + 48 * 60 * 60_000;
    expect(controller().view().kind).toBe("settled");

    storage.clear();
    signImpl = async pinned => ({
      header: "h",
      nonce: pinned ?? NONCE_A,
      txId: "t",
      ttlMs: now + 50_000,
    });
    await controller().pay(); // signed but never sent (window too short)
    expect(stored()?.totalSends).toBe(0);
    now = stored()!.expiresAt + 1;
    expect(controller().view()).toEqual({ kind: "ready" });
    expect(stored()).toBeUndefined();
  });

  it("stops a tab that loaded before another tab's delivery from paying again silently", async () => {
    const staleTab = controller();
    now += 1_000;
    responses = [ok()];
    const payingTab = controller();
    await payingTab.pay();
    await payingTab.completeDelivery();
    expect(stored()).toBeUndefined();

    expect(staleTab.view()).toEqual({ kind: "paid_elsewhere" });
    expect(await staleTab.pay()).toEqual({ kind: "paid_elsewhere" });
    expect(await staleTab.discard(false)).toEqual({ kind: "paid_elsewhere" });
    expect(signCalls).toHaveLength(1);

    // A page loaded after the delivery is a normal new purchase.
    now += 1_000;
    expect(controller().view()).toEqual({ kind: "ready" });

    // The stale tab may buy again only after an explicit acknowledgement.
    expect(await staleTab.discard(true)).toEqual({ kind: "ready" });
    responses = [ok()];
    expect((await staleTab.pay()).kind).toBe("success");
    expect(signCalls).toHaveLength(2);
  });

  it("orders deliveries on this device, not by server clocks", async () => {
    // The stale tab came from a server 30 s ahead; the delivering tab from one
    // 30 s behind. Time comparison would call the delivery "older".
    now += 30_000;
    const staleTab = controller();
    now -= 60_000;
    responses = [ok()];
    const payingTab = controller();
    await payingTab.pay();
    await payingTab.completeDelivery();
    expect(staleTab.view()).toEqual({ kind: "paid_elsewhere" });
    expect(await staleTab.pay()).toEqual({ kind: "paid_elsewhere" });
    // The delivering tab itself is not "paid elsewhere".
    expect(payingTab.view()).toEqual({ kind: "ready" });
    expect(signCalls).toHaveLength(1);
  });

  it("treats an unreadable delivery marker as a recent delivery", async () => {
    const tab = controller();
    storage.setItem(`${paymentRecordKey(URL, REQ)}|delivered`, "{broken");
    expect(tab.view()).toEqual({ kind: "paid_elsewhere" });
    storage.setItem(`${paymentRecordKey(URL, REQ)}|delivered`, JSON.stringify({ atMs: "soon" }));
    expect(tab.view()).toEqual({ kind: "paid_elsewhere" });
  });

  it("an acknowledgement covers only that delivery, not a later one", async () => {
    const staleTab = controller();
    storage.setItem(`${paymentRecordKey(URL, REQ)}|delivered`, "{broken");
    expect(await staleTab.discard(true)).toEqual({ kind: "ready" });
    expect(staleTab.view()).toEqual({ kind: "ready" });

    // Another tab (which had acknowledged the broken marker too) now delivers
    // a payment and replaces the marker with a valid, later one.
    now += 1_000;
    storage.setItem(
      `${paymentRecordKey(URL, REQ)}|delivered`,
      JSON.stringify({ atMs: now, id: "other-tab-delivery" }),
    );
    expect(staleTab.view()).toEqual({ kind: "paid_elsewhere" });
    expect(await staleTab.pay()).toEqual({ kind: "paid_elsewhere" });
    expect(signCalls).toHaveLength(0);

    // Every delivery writes a distinct marker (unique id), even at the same time.
    const first = storage.getItem(`${paymentRecordKey(URL, REQ)}|delivered`);
    now += 1;
    responses = [ok()];
    const freshTab = controller();
    expect((await freshTab.pay()).kind).toBe("success");
    now -= 1;
    await freshTab.completeDelivery();
    expect(storage.getItem(`${paymentRecordKey(URL, REQ)}|delivered`)).not.toBe(first);
  });

  it("refuses to pay over an unreadable record until the user resets it", async () => {
    // Structurally incomplete v1: the fields an older check looked at, but no
    // version, requirement or broadcast flags.
    const incomplete = {
      v: 1,
      nonce: NONCE_A,
      ttlMs: now,
      sendCount: 1,
      totalSends: 1,
      signCount: 1,
      expiresAt: now,
    };
    for (const raw of [
      "{not json",
      JSON.stringify({ v: 2 }),
      JSON.stringify({ v: 1 }),
      JSON.stringify(incomplete),
      JSON.stringify({ ...incomplete, version: 1, nonce: "aa#0" }),
      "null",
    ]) {
      storage.setItem(paymentRecordKey(URL, REQ), raw);
      const c = controller();
      const refused = { kind: "terminal", reason: "record_unreadable" };
      expect(c.view()).toEqual(refused);
      expect(await c.pay()).toEqual(refused);
      expect(await c.checkAgain()).toEqual(refused);
      expect(await c.discard(false)).toEqual(refused);
      expect(signCalls).toHaveLength(0);
      expect(await c.discard(true)).toEqual({ kind: "ready" });
      expect(stored()).toBeUndefined();
    }
  });

  it("reports unresolved on reload once the send cap was reached", async () => {
    responses = Array.from({ length: MAX_SENDS_PER_HEADER }, () => undefined);
    const c = controller();
    for (let i = 0; i < MAX_SENDS_PER_HEADER; i++) {
      await c.pay();
      now += 10_000;
    }
    expect(controller().view().kind).toBe("unresolved");
  });

  it("refuses to pay without a real cross-tab lock", async () => {
    const c = controller({ lock: undefined });
    const refused = { kind: "terminal", reason: "no_cross_tab_lock" };
    expect(c.view()).toEqual(refused);
    expect(await c.pay()).toEqual(refused);
    expect(await c.checkAgain()).toEqual(refused);
    expect(await c.discard(true)).toEqual(refused);
    await c.completeDelivery();
    expect(signCalls).toHaveLength(0);
  });
});

describe("lock runners", () => {
  it("wraps the Web Locks API when present", async () => {
    const request = vi.fn((_name: string, fn: () => Promise<number>) => fn());
    const runner = webLocksRunner({ locks: { request } })!;
    expect(await runner("k", async () => 7)).toBe(7);
    expect(request).toHaveBeenCalledWith("k", expect.any(Function));
    expect(webLocksRunner({})).toBeUndefined();
    expect(webLocksRunner(undefined)).toBeUndefined();
  });
});
