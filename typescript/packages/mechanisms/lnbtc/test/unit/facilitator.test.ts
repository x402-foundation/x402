import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { hexToBytes } from "@noble/hashes/utils";
import { bech32 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { mcpToolCallBinding } from "../../src/binding";
import { Errors, LNBTC_MAINNET, LNBTC_TESTNET } from "../../src/constants";
import { ExactLnbtcScheme } from "../../src/exact/facilitator";
import { InMemoryReplayStore } from "../../src/replayStore";
import type { ReplayStore } from "../../src/types";
import {
  HTTP_A_HASH,
  HTTP_B_HASH,
  type InvoiceSpec,
  OTHER_KEY,
  SPEC_PREIMAGE,
  SPEC_TIME,
  httpArticle,
  makeInvoice,
  mcpArticle,
  payloadFor,
  requirementsFor,
} from "./helpers";

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

describe("HTTP settlement vectors (specification)", () => {
  it("settles the unchanged example and reports the payment hash", async () => {
    expect(await settle()).toEqual({
      success: true,
      transaction: "a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e",
      network: LNBTC_MAINNET,
    });
  });

  it("settles with the accepted invoice when the requirements carry a fresh one", async () => {
    const fresh = makeInvoice({ preimage: PREIMAGE_B }).invoice;
    expect((await settle(payloadFor(), requirementsFor(httpArticle(), fresh))).success).toBe(true);
  });

  it("accepts an unused proof against a second challenge for the same request", async () => {
    const second = requirementsFor(httpArticle(), makeInvoice({ preimage: PREIMAGE_B }).invoice);
    expect((await settle(payloadFor(), second)).success).toBe(true);
  });

  it("settles a proof presented concurrently exactly once", async () => {
    const f = facilitator();
    const second = requirementsFor(httpArticle(), makeInvoice({ preimage: PREIMAGE_B }).invoice);
    const results = await Promise.all([
      settle(payloadFor(), requirementsFor(), f),
      settle(payloadFor(), second, f),
    ]);
    expect(results.map(r => r.success).sort()).toEqual([false, true]);
    expect(results.find(r => !r.success)?.errorReason).toBe("duplicate_settlement");
  });

  it("settles two paid invoices for the same request independently", async () => {
    const f = facilitator();
    const b = makeInvoice({ preimage: PREIMAGE_B }).invoice;
    expect((await settle(payloadFor(), requirementsFor(), f)).success).toBe(true);
    const payloadB = payloadFor(requirementsFor(httpArticle(), b), PREIMAGE_B);
    expect((await settle(payloadB, requirementsFor(), f)).success).toBe(true);
  });

  it("rejects article A's proof for an actual request for article B", async () => {
    expect((await settle(payloadFor(), requirementsFor(httpArticle("B")))).errorReason).toBe(
      "invalid_exact_lnbtc_request_mismatch",
    );
  });

  it("rejects an echoed digest for B against an invoice committing to A", async () => {
    const accepted = requirementsFor(httpArticle("B"));
    expect(
      (await settle(payloadFor(accepted), requirementsFor(httpArticle("B")))).errorReason,
    ).toBe("invalid_exact_lnbtc_invoice_request_mismatch");
  });

  it.each([
    ["POST", httpArticle("A", { method: "POST" })],
    ["body 0x78", httpArticle("A", { body: Uint8Array.of(0x78) })],
  ])("rejects a changed request (%s) with an echoed digest", async (_name, binding) => {
    const r = requirementsFor(binding);
    expect((await settle(payloadFor(r), r)).errorReason).toBe(
      "invalid_exact_lnbtc_invoice_request_mismatch",
    );
  });

  it.each(["requestHash", "requestBindingProfile", "requestBindingParams"])(
    "rejects a missing %s on either side",
    async field => {
      const stripped = requirementsFor();
      delete stripped.extra[field];
      expect((await settle(payloadFor(stripped), requirementsFor())).errorReason).toBe(
        "invalid_exact_lnbtc_request_binding",
      );
      expect((await settle(payloadFor(), stripped)).errorReason).toBe(
        "invalid_exact_lnbtc_request_binding",
      );
    },
  );

  it.each([
    ["unknown profile", { requestBindingProfile: "http:9" }],
    ["missing parameters", { requestBindingParams: {} }],
    ["unknown parameter", { requestBindingParams: { headers: [], other: true } }],
  ])("rejects an %s", async (_name, patch) => {
    const r = requirementsFor();
    Object.assign(r.extra, patch);
    expect((await settle(payloadFor(r), r)).errorReason).toBe(
      "invalid_exact_lnbtc_request_binding",
    );
  });

  it("rejects a change to only the accepted header list", async () => {
    const accepted = requirementsFor();
    accepted.extra.requestBindingParams = { headers: ["accept"] };
    expect((await settle(payloadFor(accepted), requirementsFor())).errorReason).toBe(
      "invalid_exact_lnbtc_request_mismatch",
    );
  });

  it("rejects an invoice with an inline description", async () => {
    const inline = makeInvoice({ description: "article A", descriptionHash: null }).invoice;
    expect((await settle(payloadFor(requirementsFor(httpArticle(), inline)))).errorReason).toBe(
      "invalid_exact_lnbtc_invoice_description",
    );
  });
});

describe("MCP settlement vectors (specification)", () => {
  const mcpInvoice = makeInvoice({ descriptionHash: mcpArticle().requestHash }).invoice;
  const mcpRequirements = (binding = mcpArticle()) => requirementsFor(binding, mcpInvoice);

  it("settles a retried tool call", async () => {
    expect((await settle(payloadFor(mcpRequirements()), mcpRequirements())).success).toBe(true);
  });

  it("rejects a changed tool call, with or without an echoed digest", async () => {
    expect(
      (await settle(payloadFor(mcpRequirements()), mcpRequirements(mcpArticle("B")))).errorReason,
    ).toBe("invalid_exact_lnbtc_request_mismatch");
    const changed = mcpRequirements(mcpArticle("B"));
    expect((await settle(payloadFor(changed), changed)).errorReason).toBe(
      "invalid_exact_lnbtc_invoice_request_mismatch",
    );
  });

  it("rejects the HTTP invoice with MCP binding fields", async () => {
    const r = requirementsFor(mcpArticle());
    expect((await settle(payloadFor(r), r)).errorReason).toBe(
      "invalid_exact_lnbtc_invoice_request_mismatch",
    );
  });

  it("rejects a profile change to http:1 on the accepted side only", async () => {
    const accepted = mcpRequirements(httpArticle());
    expect((await settle(payloadFor(accepted), mcpRequirements())).errorReason).toBe(
      "invalid_exact_lnbtc_request_mismatch",
    );
  });
});

describe("core field, invoice, and preimage checks", () => {
  const mutateAccepted = async (mutate: (r: PaymentRequirements) => void) => {
    const accepted = requirementsFor();
    mutate(accepted);
    return (await settle(payloadFor(accepted))).errorReason;
  };
  const mutateBoth = async (mutate: (r: PaymentRequirements) => void) => {
    const r = requirementsFor();
    mutate(r);
    return (await settle(payloadFor(r), r)).errorReason;
  };

  it.each([
    [(r: PaymentRequirements) => (r.scheme = "upto"), "unsupported_scheme"],
    [(r: PaymentRequirements) => (r.network = LNBTC_TESTNET), "network_mismatch"],
    [(r: PaymentRequirements) => (r.amount = "25001"), "invalid_exact_lnbtc_amount_mismatch"],
    [(r: PaymentRequirements) => (r.asset = "SAT"), "invalid_exact_lnbtc_asset"],
    [
      (r: PaymentRequirements) => (r.payTo = "02" + "ab".repeat(32)),
      "invalid_exact_lnbtc_pay_to_mismatch",
    ],
    [
      (r: PaymentRequirements) => (r.maxTimeoutSeconds = 301),
      "invalid_exact_lnbtc_max_timeout_mismatch",
    ],
    [
      (r: PaymentRequirements) => (r.extra.assetTransferMethod = "invoice"),
      "invalid_exact_lnbtc_asset_transfer_method",
    ],
    [(r: PaymentRequirements) => delete r.extra.paymentFlow, "invalid_exact_lnbtc_payment_flow"],
    [(r: PaymentRequirements) => (r.extra.invoice = ""), "invalid_exact_lnbtc_invoice_missing"],
  ])("rejects a mismatched accepted field (%#)", async (mutate, reason) => {
    expect(await mutateAccepted(mutate)).toBe(reason);
  });

  it.each([
    [(r: PaymentRequirements) => (r.network = "lnbtc:0000"), "unsupported_network"],
    [(r: PaymentRequirements) => (r.amount = "0"), "invalid_exact_lnbtc_amount"],
    [(r: PaymentRequirements) => (r.amount = "1.5"), "invalid_exact_lnbtc_amount"],
    [(r: PaymentRequirements) => (r.maxTimeoutSeconds = 0), "invalid_exact_lnbtc_max_timeout"],
    [
      (r: PaymentRequirements) => (r.payTo = r.payTo.toUpperCase()),
      "invalid_exact_lnbtc_pay_to_malformed",
    ],
    [
      (r: PaymentRequirements) => (r.payTo = "04" + "ab".repeat(32)),
      "invalid_exact_lnbtc_pay_to_malformed",
    ],
    [
      (r: PaymentRequirements) => (r.payTo = "02" + "ff".repeat(32)),
      "invalid_exact_lnbtc_pay_to_malformed",
    ],
    [
      (r: PaymentRequirements) => (r.extra.paymentFlow = "authorization"),
      "invalid_exact_lnbtc_payment_flow",
    ],
    [
      (r: PaymentRequirements) => (r.extra.invoice = "lnbc1garbage"),
      "invalid_exact_lnbtc_invoice_decode_failed",
    ],
    [
      (r: PaymentRequirements) => (r.payTo = "03" + "cd".repeat(32)),
      "invalid_exact_lnbtc_pay_to_malformed",
    ],
  ])("rejects invalid terms on both sides (%#)", async (mutate, reason) => {
    expect(await mutateBoth(mutate)).toBe(reason);
  });

  it("resolves an omitted transfer method to bolt11 on both sides", async () => {
    expect(await mutateBoth(r => delete r.extra.assetTransferMethod)).toBeUndefined();
  });

  it("rejects a mismatched server-declared extra field but allows additive client fields", async () => {
    const r = requirementsFor();
    r.extra.campaign = { id: 1 };
    const accepted = requirementsFor();
    expect((await settle(payloadFor(accepted), r)).errorReason).toBe(
      "invalid_exact_lnbtc_extra_mismatch",
    );
    accepted.extra.campaign = { id: 2 };
    expect((await settle(payloadFor(accepted), r)).errorReason).toBe(
      "invalid_exact_lnbtc_extra_mismatch",
    );
    const additive = structuredClone(r);
    additive.extra.clientNote = "x";
    expect((await settle(payloadFor(additive), r)).success).toBe(true);
  });

  it("requires an invoice in the server requirements too", async () => {
    const r = requirementsFor();
    delete r.extra.invoice;
    expect((await settle(payloadFor(), r)).errorReason).toBe("invalid_exact_lnbtc_invoice_missing");
  });

  it.each([
    [{ key: OTHER_KEY }, "invalid_exact_lnbtc_invoice_payee_mismatch"],
    [{ currency: "tb" }, "invalid_exact_lnbtc_invoice_currency_mismatch"],
    [{ amountMsat: 26_000n }, "invalid_exact_lnbtc_invoice_amount_mismatch"],
    [{ expiry: 600 }, "invalid_exact_lnbtc_invoice_expiry_mismatch"],
    [{ timestamp: SPEC_TIME + 61 }, "invalid_exact_lnbtc_invoice_created_in_future"],
    [{ descriptionHash: null }, "invalid_exact_lnbtc_invoice_description"],
    [{ description: "article A" }, "invalid_exact_lnbtc_invoice_description"],
    [
      { rawFields: [[23, bech32.toWords(hexToBytes(HTTP_A_HASH))]] },
      "invalid_exact_lnbtc_invoice_description",
    ],
  ] as [InvoiceSpec, string][])("rejects an accepted invoice with %o", async (spec, reason) => {
    const accepted = requirementsFor(httpArticle(), makeInvoice(spec).invoice);
    expect((await settle(payloadFor(accepted))).errorReason).toBe(reason);
  });

  it("accepts a creation time exactly at the skew boundary", async () => {
    const accepted = requirementsFor(
      httpArticle(),
      makeInvoice({ timestamp: SPEC_TIME + 60 }).invoice,
    );
    expect((await settle(payloadFor(accepted))).success).toBe(true);
  });

  it.each([
    [undefined, "invalid_exact_lnbtc_preimage_missing"],
    ["AB".repeat(32), "invalid_exact_lnbtc_preimage_malformed"],
    ["zz", "invalid_exact_lnbtc_preimage_malformed"],
    ["ab".repeat(31), "invalid_exact_lnbtc_preimage_length"],
    ["ab".repeat(33), "invalid_exact_lnbtc_preimage_length"],
    [PREIMAGE_B, "invalid_exact_lnbtc_preimage_hash_mismatch"],
  ])("rejects preimage %s", async (preimage, reason) => {
    const payload = payloadFor();
    payload.payload = preimage === undefined ? {} : { preimage };
    expect((await settle(payload)).errorReason).toBe(reason);
  });
});

describe("paid-but-expired policy and replay keys", () => {
  const end = SPEC_TIME + 300;

  it("accepts settlement through invoice end plus skew, inclusive", async () => {
    expect((await settle(payloadFor(), requirementsFor(), facilitator(end))).success).toBe(true);
    expect((await settle(payloadFor(), requirementsFor(), facilitator(end + 60))).success).toBe(
      true,
    );
  });

  it("rejects settlement after the boundary", async () => {
    expect((await settle(payloadFor(), requirementsFor(), facilitator(end + 61))).errorReason).toBe(
      "invalid_exact_lnbtc_invoice_expired",
    );
  });

  it("keys consumption by network and payment hash, retained an hour past the window", async () => {
    const calls: [string, number][] = [];
    const store: ReplayStore = { consume: async (key, until) => (calls.push([key, until]), true) };
    await settle(payloadFor(), requirementsFor(), facilitator(SPEC_TIME, store));
    expect(calls).toEqual([
      [
        `${LNBTC_MAINNET}:a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e`,
        end + 60 + 3600,
      ],
    ]);
  });

  it("does not consume a proof that fails validation", async () => {
    const f = facilitator();
    expect((await settle(payloadFor(), requirementsFor(httpArticle("B")), f)).success).toBe(false);
    expect((await settle(payloadFor(), requirementsFor(), f)).success).toBe(true);
  });

  it("denies settlement when the replay store fails", async () => {
    const store: ReplayStore = { consume: async () => Promise.reject(new Error("db down")) };
    await expect(
      settle(payloadFor(), requirementsFor(), facilitator(SPEC_TIME, store)),
    ).rejects.toThrow("db down");
  });

  it("preserves the spec preimage relationship", () => {
    expect(makeInvoice({ preimage: SPEC_PREIMAGE }).paymentHash).toBe(
      "a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e",
    );
  });
});

describe("validation order (specification steps 1-7)", () => {
  const reason = async (
    mutateAccepted: (r: PaymentRequirements) => void,
    mutateRequired: (r: PaymentRequirements) => void = () => {},
    options: { now?: number; preimage?: string } = {},
  ) => {
    const accepted = requirementsFor();
    mutateAccepted(accepted);
    const required = requirementsFor();
    mutateRequired(required);
    const payload = payloadFor(accepted, options.preimage);
    return (await settle(payload, required, facilitator(options.now))).errorReason;
  };
  const invoiceWith = (spec: Parameters<typeof makeInvoice>[0]) => (r: PaymentRequirements) =>
    (r.extra.invoice = makeInvoice(spec).invoice);
  const both = (mutate: (r: PaymentRequirements) => void) => [mutate, mutate] as const;

  it.each([
    // step 1 order: scheme, network, amount, asset, payTo, maxTimeoutSeconds
    [
      "scheme before network",
      (r: PaymentRequirements) => ((r.scheme = "upto"), (r.network = LNBTC_TESTNET)),
      "unsupported_scheme",
    ],
    [
      "network before amount",
      (r: PaymentRequirements) => ((r.network = LNBTC_TESTNET), (r.amount = "1")),
      "network_mismatch",
    ],
    [
      "amount before asset",
      (r: PaymentRequirements) => ((r.amount = "1"), (r.asset = "SAT")),
      "invalid_exact_lnbtc_amount_mismatch",
    ],
    [
      "asset before payTo",
      (r: PaymentRequirements) => ((r.asset = "SAT"), (r.payTo = "02" + "ab".repeat(32))),
      "invalid_exact_lnbtc_asset",
    ],
    [
      "payTo before maxTimeoutSeconds",
      (r: PaymentRequirements) => ((r.payTo = "02" + "ab".repeat(32)), (r.maxTimeoutSeconds = 1)),
      "invalid_exact_lnbtc_pay_to_mismatch",
    ],
    [
      "a type change is a mismatch",
      (r: PaymentRequirements) => (r.amount = 25000 as unknown as string),
      "invalid_exact_lnbtc_amount_mismatch",
    ],
    [
      "step 1 before step 3",
      (r: PaymentRequirements) => ((r.maxTimeoutSeconds = 1), (r.extra.paymentFlow = "x")),
      "invalid_exact_lnbtc_max_timeout_mismatch",
    ],
    // step 3 order: method, flow, binding syntax, binding equality, other extras
    [
      "method before flow",
      (r: PaymentRequirements) => (
        (r.extra.assetTransferMethod = "x"), (r.extra.paymentFlow = "x")
      ),
      "invalid_exact_lnbtc_asset_transfer_method",
    ],
    [
      "flow before binding syntax",
      (r: PaymentRequirements) => ((r.extra.paymentFlow = "x"), (r.extra.requestHash = "x")),
      "invalid_exact_lnbtc_payment_flow",
    ],
    [
      "binding syntax before binding equality",
      (r: PaymentRequirements) => (r.extra.requestHash = HTTP_B_HASH.toUpperCase()),
      "invalid_exact_lnbtc_request_binding",
    ],
    [
      "binding equality before invoice presence",
      (r: PaymentRequirements) => ((r.extra.requestHash = HTTP_B_HASH), (r.extra.invoice = "")),
      "invalid_exact_lnbtc_request_mismatch",
    ],
    // step 4 before step 5
    [
      "invoice presence before decoding",
      (r: PaymentRequirements) => delete r.extra.invoice,
      "invalid_exact_lnbtc_invoice_missing",
    ],
    // step 5 order
    [
      "decoding before description",
      (r: PaymentRequirements) => (r.extra.invoice = "lnbc1garbage"),
      "invalid_exact_lnbtc_invoice_decode_failed",
    ],
    [
      "description before payee",
      invoiceWith({ descriptionHash: null, description: "x", key: OTHER_KEY }),
      "invalid_exact_lnbtc_invoice_description",
    ],
    [
      "description request hash before payee",
      invoiceWith({ descriptionHash: HTTP_B_HASH, key: OTHER_KEY }),
      "invalid_exact_lnbtc_invoice_request_mismatch",
    ],
    [
      "payee before currency",
      invoiceWith({ key: OTHER_KEY, currency: "tb" }),
      "invalid_exact_lnbtc_invoice_payee_mismatch",
    ],
    [
      "currency before amount",
      invoiceWith({ currency: "tb", amountMsat: 1n }),
      "invalid_exact_lnbtc_invoice_currency_mismatch",
    ],
    [
      "amount before expiry",
      invoiceWith({ amountMsat: 1n, expiry: 1 }),
      "invalid_exact_lnbtc_invoice_amount_mismatch",
    ],
    [
      "expiry before creation time",
      invoiceWith({ expiry: 1, timestamp: SPEC_TIME + 61 }),
      "invalid_exact_lnbtc_invoice_expiry_mismatch",
    ],
  ])("%s", async (_name, mutate, expected) => {
    expect(await reason(mutate)).toBe(expected);
  });

  it("checks the requirement side of step 1-2 terms (step 2) before step 3", async () => {
    expect(await reason(...both(r => ((r.amount = "0"), (r.extra.paymentFlow = "x"))))).toBe(
      "invalid_exact_lnbtc_amount",
    );
  });

  it("checks the creation time (step 5) before the preimage (step 6)", async () => {
    expect(
      await reason(invoiceWith({ timestamp: SPEC_TIME + 61 }), undefined, {
        preimage: PREIMAGE_B,
      }),
    ).toBe("invalid_exact_lnbtc_invoice_created_in_future");
  });

  it("checks the preimage (step 6) before the expiry policy (step 7)", async () => {
    expect(await reason(() => {}, undefined, { now: SPEC_TIME + 361, preimage: PREIMAGE_B })).toBe(
      "invalid_exact_lnbtc_preimage_hash_mismatch",
    );
    expect(await reason(() => {}, undefined, { now: SPEC_TIME + 361 })).toBe(
      "invalid_exact_lnbtc_invoice_expired",
    );
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

  it("keys the same payment hash separately per network", async () => {
    const store = new InMemoryReplayStore();
    const testnet = { ...requirementsFor(), network: LNBTC_TESTNET };
    testnet.extra = { ...testnet.extra, invoice: makeInvoice({ currency: "tb" }).invoice };
    expect(
      (await settle(payloadFor(), requirementsFor(), facilitator(SPEC_TIME, store))).success,
    ).toBe(true);
    expect(
      (await settle(payloadFor(testnet), testnet, facilitator(SPEC_TIME, store))).success,
    ).toBe(true);
    expect(
      (await settle(payloadFor(), requirementsFor(), facilitator(SPEC_TIME, store))).errorReason,
    ).toBe("duplicate_settlement");
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

describe("remaining specification cases", () => {
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

  it.each(["+25000", "25000.0", "2.5e4", "25_000", "25,000", "25000msat", " 25000", "-25000", ""])(
    "rejects the amount %j on both sides",
    async amount => {
      const r = requirementsFor();
      r.amount = amount;
      expect((await settle(payloadFor(r), r)).errorReason).toBe("invalid_exact_lnbtc_amount");
    },
  );

  it.each([
    "lnbtc:*",
    "lnbtc:000000000019d6689c085ae165831e93 ",
    "LNBTC:000000000019d6689c085ae165831e93",
  ])("requires a concrete supported network, not %j", async network => {
    const r = requirementsFor();
    r.network = network as never;
    expect((await settle(payloadFor(r), r)).errorReason).toBe("unsupported_network");
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

  it("settles when the accepted MCP parameters differ only in member order", async () => {
    const invoice = makeInvoice({ descriptionHash: mcpArticle().requestHash }).invoice;
    const required = requirementsFor(mcpArticle(), invoice);
    const accepted = requirementsFor(mcpArticle(), invoice);
    accepted.extra.requestBindingParams = {
      metadata: [],
      server: "https://api.example.com/mcp",
    };
    expect((await settle(payloadFor(accepted), required)).success).toBe(true);
  });

  it("rejects a changed bound metadata value (absent to null) with an echoed digest", async () => {
    const call = (meta?: Record<string, unknown>) =>
      mcpToolCallBinding({
        server: "https://api.example.com/mcp",
        name: "get_article",
        arguments: { article: "A" },
        meta,
        boundMetadata: ["tier"],
      });
    const invoice = makeInvoice({ descriptionHash: call({}).requestHash }).invoice;
    const paid = requirementsFor(call({}), invoice);
    expect((await settle(payloadFor(paid), paid)).success).toBe(true);
    const changed = requirementsFor(call({ tier: null }), invoice);
    expect((await settle(payloadFor(changed), changed)).errorReason).toBe(
      "invalid_exact_lnbtc_invoice_request_mismatch",
    );
  });
});
