import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import { Errors, LNBTC_MAINNET } from "../../src/constants";
import { ExactLnbtcScheme } from "../../src/exact/facilitator";
import { InMemoryReplayStore } from "../../src/replayStore";
import type { ReplayStore } from "../../src/types";
import {
  OTHER_KEY,
  SPEC_PREIMAGE,
  SPEC_TIME,
  httpArticle,
  makeInvoice,
  payloadFor,
  requirementsFor,
} from "./helpers";

// Specification settlement cases run from the shared vectors
// (shared-vectors.test.ts). This file covers what a data vector cannot:
// metadata, configuration, JavaScript input shapes, and the replay store
// contract.

const facilitator = (now = SPEC_TIME, store: ReplayStore = new InMemoryReplayStore()) =>
  new ExactLnbtcScheme({ replayStore: store, clock: () => now });

const settle = (
  payload: PaymentPayload = payloadFor(),
  requirements: PaymentRequirements = requirementsFor(),
  scheme = facilitator(),
) => scheme.settle(payload, requirements);

const PREIMAGE_B = "ff".repeat(32);

describe("facilitator metadata", () => {
  it("advertises bolt11/upfront, has no signers, and refuses /verify", async () => {
    const f = facilitator();
    expect(f.scheme).toBe("exact");
    expect(f.caipFamily).toBe("lnbtc:*");
    expect(f.getExtra(LNBTC_MAINNET)).toEqual({
      assetTransferMethod: "bolt11",
      paymentFlow: "upfront",
    });
    expect(f.getExtra("lnbtc:unknown")).toBeUndefined();
    expect(f.getSigners(LNBTC_MAINNET)).toEqual([]);
    expect(await f.verify(payloadFor(), requirementsFor())).toEqual({
      isValid: false,
      invalidReason: "invalid_exact_lnbtc_payment_flow",
    });
  });

  it("rejects a negative or fractional clock skew", () => {
    const replayStore = new InMemoryReplayStore();
    expect(() => new ExactLnbtcScheme({ replayStore, clockSkewSeconds: -1 })).toThrow(RangeError);
    expect(() => new ExactLnbtcScheme({ replayStore, clockSkewSeconds: 1.5 })).toThrow(RangeError);
  });
});

describe("untrusted input shapes", () => {
  it("propagates unexpected errors instead of mapping them to a reason", async () => {
    const payload = payloadFor();
    Object.defineProperty(payload.accepted, "amount", {
      get: () => {
        throw new Error("boom");
      },
    });
    await expect(settle(payload)).rejects.toThrow("boom");
  });

  it("uses the system clock by default", async () => {
    const now = Math.floor(Date.now() / 1000);
    const r = requirementsFor(httpArticle(), makeInvoice({ timestamp: now }).invoice);
    const f = new ExactLnbtcScheme({ replayStore: new InMemoryReplayStore() });
    expect((await f.settle(payloadFor(r), r)).success).toBe(true);
    const old = requirementsFor();
    expect((await f.settle(payloadFor(old), old)).errorReason).toBe(
      "invalid_exact_lnbtc_invoice_expired",
    );
  });

  it.each([
    ["a null payload", null],
    ["a payload without accepted", { x402Version: 2, payload: { preimage: SPEC_PREIMAGE } }],
    ["a string accepted", { x402Version: 2, accepted: "exact", payload: {} }],
    ["a null accepted", { x402Version: 2, accepted: null, payload: {} }],
  ])("returns unsupported_scheme for %s", async (_name, payload) => {
    expect((await settle(payload as unknown as PaymentPayload)).errorReason).toBe(
      "unsupported_scheme",
    );
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "treats the inherited property %s as an unsupported network",
    async network => {
      const r = requirementsFor();
      r.network = network as never;
      expect((await settle(payloadFor(r), r)).errorReason).toBe("unsupported_network");
      expect(facilitator().getExtra(network as never)).toBeUndefined();
    },
  );

  it.each([null, "BOLT11", 1])(
    "rejects an explicit asset transfer method %o on either side",
    async method => {
      const r = requirementsFor();
      r.extra.assetTransferMethod = method;
      const expected = "invalid_exact_lnbtc_asset_transfer_method";
      expect((await settle(payloadFor(r))).errorReason).toBe(expected);
      expect((await settle(payloadFor(), r)).errorReason).toBe(expected);
    },
  );

  it.each([
    [null, "invalid_exact_lnbtc_invoice_missing"],
    [42, "invalid_exact_lnbtc_invoice_decode_failed"],
    [["lnbc"], "invalid_exact_lnbtc_invoice_decode_failed"],
    [{ invoice: SPEC_PREIMAGE }, "invalid_exact_lnbtc_invoice_decode_failed"],
  ])("classifies an accepted invoice of %o", async (invoice, expected) => {
    const accepted = requirementsFor();
    accepted.extra.invoice = invoice;
    expect((await settle(payloadFor(accepted))).errorReason).toBe(expected);
  });

  it.each([
    [null, "invalid_exact_lnbtc_preimage_missing"],
    [42, "invalid_exact_lnbtc_preimage_malformed"],
    [[SPEC_PREIMAGE], "invalid_exact_lnbtc_preimage_malformed"],
    [" " + SPEC_PREIMAGE.slice(1), "invalid_exact_lnbtc_preimage_malformed"],
    ["0x" + SPEC_PREIMAGE.slice(2), "invalid_exact_lnbtc_preimage_malformed"],
    ["", "invalid_exact_lnbtc_preimage_length"],
    [SPEC_PREIMAGE.slice(1), "invalid_exact_lnbtc_preimage_length"],
  ])("classifies a preimage of %o", async (preimage, expected) => {
    const payload = payloadFor();
    payload.payload = { preimage } as never;
    expect((await settle(payload)).errorReason).toBe(expected);
    const bare = payloadFor();
    bare.payload = "x" as never;
    expect((await settle(bare)).errorReason).toBe("invalid_exact_lnbtc_preimage_missing");
  });

  it("does not satisfy a server-declared extra from the prototype chain", async () => {
    const required = requirementsFor();
    Object.defineProperty(required.extra, "__proto__", {
      value: {},
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect((await settle(payloadFor(), required)).errorReason).toBe(
      "invalid_exact_lnbtc_extra_mismatch",
    );
  });

  it("compares extra values by JCS and fails closed on non-JSON values", async () => {
    const required = requirementsFor();
    required.extra.campaign = { a: 1, b: [1, 2] };
    const accepted = requirementsFor();
    accepted.extra.campaign = { b: [1, 2], a: 1 };
    expect((await settle(payloadFor(accepted), required)).success).toBe(true);
    const nan = requirementsFor();
    nan.extra.campaign = Number.NaN;
    expect((await settle(payloadFor(nan), nan)).errorReason).toBe(
      "invalid_exact_lnbtc_extra_mismatch",
    );
  });

  it("rejects an n field naming a key other than payTo, even when it signed", async () => {
    const accepted = requirementsFor(
      httpArticle(),
      makeInvoice({ key: OTHER_KEY, payeeField: true }).invoice,
    );
    expect((await settle(payloadFor(accepted))).errorReason).toBe(
      "invalid_exact_lnbtc_invoice_payee_mismatch",
    );
  });
});

describe("replay store contract", () => {
  it.each([
    ["false", false],
    ["undefined", undefined],
    ["a truthy object", { rowCount: 0 }],
    ["1", 1],
    ["'true'", "true"],
  ])("treats a consume result of %s as not inserted", async (_name, result) => {
    const store = { consume: async () => result } as unknown as ReplayStore;
    expect(
      (await settle(payloadFor(), requirementsFor(), facilitator(SPEC_TIME, store))).errorReason,
    ).toBe("duplicate_settlement");
  });

  it("is not consulted when validation fails", async () => {
    const consume = vi.fn(async () => true);
    const f = facilitator(SPEC_TIME, { consume });
    await settle(payloadFor(), requirementsFor(httpArticle("B")), f);
    await settle(payloadFor(requirementsFor(), PREIMAGE_B), requirementsFor(), f);
    expect(consume).not.toHaveBeenCalled();
  });

  it("denies settlement when the replay store fails", async () => {
    const store: ReplayStore = { consume: async () => Promise.reject(new Error("db down")) };
    await expect(
      settle(payloadFor(), requirementsFor(), facilitator(SPEC_TIME, store)),
    ).rejects.toThrow("db down");
  });

  it("uses the configured skew for the window and the retention", async () => {
    const calls: number[] = [];
    const store: ReplayStore = { consume: async (_key, until) => (calls.push(until), true) };
    const strict = (now: number) =>
      new ExactLnbtcScheme({ replayStore: store, clock: () => now, clockSkewSeconds: 0 });
    const end = SPEC_TIME + 300;
    expect((await settle(payloadFor(), requirementsFor(), strict(end))).success).toBe(true);
    expect(calls).toEqual([end + 3600]);
    expect((await settle(payloadFor(), requirementsFor(), strict(end + 1))).errorReason).toBe(
      "invalid_exact_lnbtc_invoice_expired",
    );
    const future = requirementsFor(
      httpArticle(),
      makeInvoice({ timestamp: SPEC_TIME + 1 }).invoice,
    );
    expect(
      (await settle(payloadFor(future), requirementsFor(), strict(SPEC_TIME))).errorReason,
    ).toBe("invalid_exact_lnbtc_invoice_created_in_future");
  });
});

describe("error vocabulary", () => {
  it("uses the stable error strings of the specification", () => {
    expect(Object.values(Errors).sort()).toEqual(
      [
        "unsupported_scheme",
        "network_mismatch",
        "unsupported_network",
        "duplicate_settlement",
        "invalid_exact_lnbtc_asset",
        "invalid_exact_lnbtc_amount",
        "invalid_exact_lnbtc_amount_mismatch",
        "invalid_exact_lnbtc_pay_to_mismatch",
        "invalid_exact_lnbtc_pay_to_malformed",
        "invalid_exact_lnbtc_max_timeout_mismatch",
        "invalid_exact_lnbtc_max_timeout",
        "invalid_exact_lnbtc_extra_mismatch",
        "invalid_exact_lnbtc_request_binding",
        "invalid_exact_lnbtc_request_mismatch",
        "invalid_exact_lnbtc_asset_transfer_method",
        "invalid_exact_lnbtc_payment_flow",
        "invalid_exact_lnbtc_invoice_missing",
        "invalid_exact_lnbtc_invoice_decode_failed",
        "invalid_exact_lnbtc_invoice_description",
        "invalid_exact_lnbtc_invoice_request_mismatch",
        "invalid_exact_lnbtc_invoice_payee_mismatch",
        "invalid_exact_lnbtc_invoice_currency_mismatch",
        "invalid_exact_lnbtc_invoice_amount_mismatch",
        "invalid_exact_lnbtc_invoice_expiry_mismatch",
        "invalid_exact_lnbtc_invoice_created_in_future",
        "invalid_exact_lnbtc_invoice_expired",
        "invalid_exact_lnbtc_preimage_missing",
        "invalid_exact_lnbtc_preimage_malformed",
        "invalid_exact_lnbtc_preimage_length",
        "invalid_exact_lnbtc_preimage_hash_mismatch",
        "exact_lnbtc_invoice_issuance_denied",
        "invalid_exact_lnbtc_payer_invoice_mismatch",
        "invalid_exact_lnbtc_payer_payment_hash_mismatch",
        "invalid_exact_lnbtc_payer_amount_mismatch",
        "exact_lnbtc_payment_in_flight",
        "exact_lnbtc_payment_not_paid",
        "invalid_exact_lnbtc_payer_preimage_required",
        "invalid_exact_lnbtc_payer_preimage_malformed",
        "invalid_exact_lnbtc_payer_preimage_hash_mismatch",
      ].sort(),
    );
  });
});
