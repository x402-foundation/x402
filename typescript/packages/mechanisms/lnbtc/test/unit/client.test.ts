import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import type { PaymentCreationContext } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import { ExactLnbtcScheme } from "../../src/exact/client";
import type { LightningPayment, LightningPayer } from "../../src/types";
import {
  HTTP_B_HASH,
  OTHER_KEY,
  SPEC_INVOICE,
  SPEC_PREIMAGE,
  SPEC_TIME,
  httpArticle,
  makeInvoice,
  mcpArticle,
  requirementsFor,
} from "./helpers";

const OTHER_PUBKEY = bytesToHex(secp256k1.getPublicKey(OTHER_KEY, true));
const PAYMENT_HASH = "a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e";

const paid = (overrides: Partial<LightningPayment> = {}): LightningPayment => ({
  invoice: SPEC_INVOICE,
  paymentHash: PAYMENT_HASH,
  amountMsat: 25_000n,
  status: "paid",
  preimage: SPEC_PREIMAGE,
  ...overrides,
});

const client = (payment: LightningPayment = paid(), binding = httpArticle(), now = SPEC_TIME) => {
  const payer: LightningPayer = { payInvoice: vi.fn(async () => payment) };
  const scheme = new ExactLnbtcScheme({ payer, requestBinding: () => binding, clock: () => now });
  return { scheme, payer };
};

const pay = (scheme: ExactLnbtcScheme, requirements: PaymentRequirements = requirementsFor()) =>
  scheme.createPaymentPayload(2, requirements);

describe("client payment construction", () => {
  it("pays a valid request-bound invoice and returns the preimage", async () => {
    const { scheme, payer } = client();
    expect(await pay(scheme)).toEqual({ x402Version: 2, payload: { preimage: SPEC_PREIMAGE } });
    expect(payer.payInvoice).toHaveBeenCalledWith(
      SPEC_INVOICE,
      "lnbtc:000000000019d6689c085ae165831e93",
    );
  });

  it("refuses a challenge bound to a different request before paying", async () => {
    const { scheme, payer } = client(paid(), httpArticle("B"));
    await expect(pay(scheme)).rejects.toThrow("invalid_exact_lnbtc_request_mismatch");
    expect(payer.payInvoice).not.toHaveBeenCalled();
  });

  it("refuses a challenge advertising http:1 for an MCP tool call", async () => {
    const { scheme, payer } = client(paid(), mcpArticle());
    await expect(pay(scheme)).rejects.toThrow("invalid_exact_lnbtc_request_mismatch");
    expect(payer.payInvoice).not.toHaveBeenCalled();
  });

  it("refuses an invoice whose description hash differs from the advertised hash", async () => {
    const r = requirementsFor(httpArticle("B"), SPEC_INVOICE);
    const { scheme, payer } = client(paid(), httpArticle("B"));
    await expect(pay(scheme, r)).rejects.toThrow("invalid_exact_lnbtc_invoice_request_mismatch");
    expect(payer.payInvoice).not.toHaveBeenCalled();
  });

  it.each([
    [{ amount: "0" }, "invalid_exact_lnbtc_amount"],
    [{ asset: "USDC" }, "invalid_exact_lnbtc_asset"],
    [{ network: "lnbtc:ffff" }, "unsupported_network"],
    [
      { extra: { ...requirementsFor().extra, paymentFlow: "escrow" } },
      "invalid_exact_lnbtc_payment_flow",
    ],
    [
      { extra: { ...requirementsFor().extra, invoice: undefined } },
      "invalid_exact_lnbtc_invoice_missing",
    ],
  ])("refuses invalid requirements %o", async (patch, reason) => {
    const { scheme, payer } = client();
    const requirements = { ...requirementsFor(), ...patch } as PaymentRequirements;
    await expect(pay(scheme, requirements)).rejects.toThrow(reason);
    expect(payer.payInvoice).not.toHaveBeenCalled();
  });

  it("refuses an expired invoice and one created too far in the future", async () => {
    await expect(pay(client(paid(), httpArticle(), SPEC_TIME + 300).scheme)).rejects.toThrow(
      "invalid_exact_lnbtc_invoice_expired",
    );
    const future = makeInvoice({ timestamp: SPEC_TIME + 61 }).invoice;
    await expect(pay(client().scheme, requirementsFor(httpArticle(), future))).rejects.toThrow(
      "invalid_exact_lnbtc_invoice_created_in_future",
    );
  });

  it("pays at the expiry and creation-time boundaries and refuses just past them", async () => {
    expect((await pay(client(paid(), httpArticle(), SPEC_TIME + 299).scheme)).payload).toEqual({
      preimage: SPEC_PREIMAGE,
    });
    const atSkew = makeInvoice({ timestamp: SPEC_TIME + 60 }).invoice;
    const { scheme } = client(paid({ invoice: atSkew }));
    expect((await pay(scheme, requirementsFor(httpArticle(), atSkew))).payload).toBeDefined();
  });

  it.each([
    [{ asset: "BTC " }, "invalid_exact_lnbtc_asset"],
    [{ scheme: "upto" }, "unsupported_scheme"],
    [{ network: "constructor" }, "unsupported_network"],
    [{ payTo: "02" + "ff".repeat(32) }, "invalid_exact_lnbtc_pay_to_malformed"],
    [{ maxTimeoutSeconds: 300.5 }, "invalid_exact_lnbtc_max_timeout"],
    [{ amount: "025000" }, "invalid_exact_lnbtc_amount"],
    [{ maxTimeoutSeconds: 600 }, "invalid_exact_lnbtc_invoice_expiry_mismatch"],
    [{ amount: "26000" }, "invalid_exact_lnbtc_invoice_amount_mismatch"],
    [{ payTo: OTHER_PUBKEY }, "invalid_exact_lnbtc_invoice_payee_mismatch"],
    [
      { extra: { ...requirementsFor().extra, assetTransferMethod: "lnurl" } },
      "invalid_exact_lnbtc_asset_transfer_method",
    ],
    [
      { extra: { ...requirementsFor().extra, requestBindingProfile: "http:2" } },
      "invalid_exact_lnbtc_request_binding",
    ],
    [
      { extra: { ...requirementsFor().extra, requestHash: HTTP_B_HASH } },
      "invalid_exact_lnbtc_request_mismatch",
    ],
    [
      { extra: { ...requirementsFor().extra, requestBindingParams: { headers: ["accept"] } } },
      "invalid_exact_lnbtc_request_mismatch",
    ],
    [
      {
        extra: {
          ...requirementsFor().extra,
          invoice: makeInvoice({ description: "A", descriptionHash: null }).invoice,
        },
      },
      "invalid_exact_lnbtc_invoice_description",
    ],
    [
      { extra: { ...requirementsFor().extra, invoice: makeInvoice({ currency: "tb" }).invoice } },
      "invalid_exact_lnbtc_invoice_currency_mismatch",
    ],
  ])("refuses %o before paying", async (patch, reason) => {
    const { scheme, payer } = client();
    const requirements = { ...requirementsFor(), ...patch } as PaymentRequirements;
    await expect(pay(scheme, requirements)).rejects.toThrow(reason);
    expect(payer.payInvoice).not.toHaveBeenCalled();
  });

  it("refuses an amount above the spend cap before paying", async () => {
    const { scheme, payer } = client();
    await expect(
      scheme.createPaymentPayload(2, requirementsFor(), { maxAmountPerPayment: "24999" }),
    ).rejects.toThrow("maxAmountPerPayment");
    await expect(
      scheme.createPaymentPayload(2, requirementsFor(), { maxAmountPerPayment: "$1" }),
    ).rejects.toThrow("maxAmountPerPayment");
    expect(payer.payInvoice).not.toHaveBeenCalled();
    const capped = await scheme.createPaymentPayload(2, requirementsFor(), {
      maxAmountPerPayment: "25000",
    });
    expect(capped.payload).toEqual({ preimage: SPEC_PREIMAGE });
  });

  it.each([
    [{ invoice: "lnbc1other" }, "invalid_exact_lnbtc_payer_invoice_mismatch"],
    [{ invoice: SPEC_INVOICE.toUpperCase() }, "invalid_exact_lnbtc_payer_invoice_mismatch"],
    [{ amountMsat: 25_000 as unknown as bigint }, "invalid_exact_lnbtc_payer_amount_mismatch"],
    [{ amountMsat: 25_100n }, "invalid_exact_lnbtc_payer_amount_mismatch"],
    [{ preimage: "" }, "invalid_exact_lnbtc_payer_preimage_malformed"],
    [{ preimage: null as unknown as string }, "invalid_exact_lnbtc_payer_preimage_required"],
    [
      { preimage: [SPEC_PREIMAGE] as unknown as string },
      "invalid_exact_lnbtc_payer_preimage_malformed",
    ],
    [{ paymentHash: "00".repeat(32) }, "invalid_exact_lnbtc_payer_payment_hash_mismatch"],
    [{ amountMsat: 25_001n }, "invalid_exact_lnbtc_payer_amount_mismatch"],
    [{ status: "in_flight" as const }, "exact_lnbtc_payment_in_flight"],
    [{ status: "unpaid" as const }, "exact_lnbtc_payment_not_paid"],
    [{ preimage: undefined }, "invalid_exact_lnbtc_payer_preimage_required"],
    [{ preimage: "AB".repeat(32) }, "invalid_exact_lnbtc_payer_preimage_malformed"],
    [{ preimage: "ff".repeat(32) }, "invalid_exact_lnbtc_payer_preimage_hash_mismatch"],
  ])("rejects payer result %o", async (patch, reason) => {
    await expect(pay(client(paid(patch)).scheme)).rejects.toThrow(reason);
  });
});

describe("client resource check hook", () => {
  const hook = (binding = httpArticle(), url = "https://api.example.com/article/A") => {
    const { scheme } = client(paid(), binding);
    const ctx = {
      paymentRequired: { x402Version: 2, resource: { url }, accepts: [] },
      selectedRequirements: requirementsFor(),
    } as unknown as PaymentCreationContext;
    return scheme.schemeHooks.onBeforePaymentCreation!(ctx);
  };

  it("allows a matching resource URL and any URL for MCP", async () => {
    expect(await hook()).toBeUndefined();
    expect(await hook(mcpArticle(), "mcp://tool/get_article")).toBeUndefined();
  });

  it("aborts when the resource URL differs from the intended request", async () => {
    expect(await hook(httpArticle(), "https://api.example.com/article/B")).toEqual({
      abort: true,
      reason: "invalid_exact_lnbtc_request_mismatch",
    });
  });

  it("aborts with the binding reason when the intended request is invalid", async () => {
    const payer: LightningPayer = { payInvoice: vi.fn() };
    const scheme = new ExactLnbtcScheme({
      payer,
      requestBinding: () => httpArticle("A#fragment"),
    });
    const ctx = {
      paymentRequired: { resource: { url: "x" } },
    } as unknown as PaymentCreationContext;
    expect(await scheme.schemeHooks.onBeforePaymentCreation!(ctx)).toEqual({
      abort: true,
      reason: "invalid_exact_lnbtc_request_binding",
    });
  });

  it("uses the system clock by default", async () => {
    const now = Math.floor(Date.now() / 1000);
    const invoice = makeInvoice({ timestamp: now }).invoice;
    const payer: LightningPayer = { payInvoice: vi.fn(async () => paid({ invoice })) };
    const scheme = new ExactLnbtcScheme({ payer, requestBinding: () => httpArticle() });
    expect((await pay(scheme, requirementsFor(httpArticle(), invoice))).payload).toEqual({
      preimage: SPEC_PREIMAGE,
    });
    await expect(pay(scheme)).rejects.toThrow("invalid_exact_lnbtc_invoice_expired");
  });

  it("propagates unexpected errors from the request binding provider", async () => {
    const payer: LightningPayer = { payInvoice: vi.fn() };
    const scheme = new ExactLnbtcScheme({
      payer,
      requestBinding: () => {
        throw new (class extends Error {})("boom");
      },
    });
    const ctx = {
      paymentRequired: { resource: { url: "x" } },
    } as unknown as PaymentCreationContext;
    await expect(scheme.schemeHooks.onBeforePaymentCreation!(ctx)).rejects.toThrow("boom");
  });
});
