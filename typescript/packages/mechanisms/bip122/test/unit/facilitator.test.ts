import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExactBip122FacilitatorScheme } from "../../src/exact/facilitator/scheme";
import type { LightningReceiver, LightningInvoiceStatus, DecodedBolt11 } from "../../src/exact/types";
import { BTC_MAINNET_CAIP2 } from "../../src/exact/constants";

const PAYMENT_HASH = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1";
const INVOICE = "lnbc1u1p3xyz_test_invoice_string";
const AMOUNT_MSAT = 1_000_000; // 1000 sats
const NOW_SEC = 1_700_000_000;
const EXPIRES_AT = NOW_SEC + 3600;

function makeDecoded(overrides?: Partial<DecodedBolt11>): DecodedBolt11 {
  return {
    paymentHash: PAYMENT_HASH,
    amountMsat: AMOUNT_MSAT,
    timestamp: NOW_SEC,
    expiry: 3600,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function makeRequirements(extra?: Record<string, unknown>) {
  return {
    scheme: "exact",
    network: BTC_MAINNET_CAIP2,
    amount: String(AMOUNT_MSAT),
    asset: "BTC",
    payTo: "anonymous",
    maxTimeoutSeconds: 60,
    extra: {
      paymentMethod: "lightning",
      invoice: INVOICE,
      ...extra,
    },
  } as Parameters<ExactBip122FacilitatorScheme["verify"]>[1];
}

function makeReceiver(status: LightningInvoiceStatus["status"] = "paid"): LightningReceiver {
  const s: LightningInvoiceStatus = {
    invoice: INVOICE,
    paymentHash: PAYMENT_HASH,
    amountMsat: AMOUNT_MSAT,
    expiresAt: EXPIRES_AT,
    status,
  };
  return {
    createInvoice: vi.fn(),
    lookupInvoice: vi.fn().mockResolvedValue(s),
  };
}

describe("ExactBip122FacilitatorScheme.verify", () => {
  let facilitator: ExactBip122FacilitatorScheme;
  let receiver: LightningReceiver;

  beforeEach(() => {
    receiver = makeReceiver("paid");
    facilitator = new ExactBip122FacilitatorScheme({
      receiver,
      decodeBolt11Fn: () => makeDecoded(),
      nowFn: () => NOW_SEC * 1000,
    });
  });

  it("verifies a valid paid invoice", async () => {
    const result = await facilitator.verify({ invoice: INVOICE }, makeRequirements());
    expect(result.verified).toBe(true);
    expect(result.paymentHash).toBe(PAYMENT_HASH);
  });

  it("rejects unsupported network", async () => {
    const req = { ...makeRequirements(), network: "eip155:1" };
    const result = await facilitator.verify({ invoice: INVOICE }, req as never);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("unsupported_network");
  });

  it("rejects invoice substitution — payload.invoice !== requirements.extra.invoice", async () => {
    const result = await facilitator.verify(
      { invoice: "lnbc_different_invoice" },
      makeRequirements(),
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("invoice_substitution");
  });

  it("rejects expired invoice", async () => {
    facilitator = new ExactBip122FacilitatorScheme({
      receiver,
      decodeBolt11Fn: () => makeDecoded({ expiresAt: NOW_SEC - 1 }),
      nowFn: () => NOW_SEC * 1000,
    });
    const result = await facilitator.verify({ invoice: INVOICE }, makeRequirements());
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("invoice_expired");
  });

  it("rejects amount mismatch", async () => {
    facilitator = new ExactBip122FacilitatorScheme({
      receiver,
      decodeBolt11Fn: () => makeDecoded({ amountMsat: 999 }),
      nowFn: () => NOW_SEC * 1000,
    });
    const result = await facilitator.verify({ invoice: INVOICE }, makeRequirements());
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("amount_mismatch");
  });

  it("rejects duplicate settlement (replay attack)", async () => {
    await facilitator.settle({ invoice: INVOICE }, makeRequirements());
    const result = await facilitator.verify({ invoice: INVOICE }, makeRequirements());
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("duplicate_settlement");
  });

  it("rejects unpaid invoice", async () => {
    receiver = makeReceiver("unpaid");
    facilitator = new ExactBip122FacilitatorScheme({
      receiver,
      decodeBolt11Fn: () => makeDecoded(),
      nowFn: () => NOW_SEC * 1000,
    });
    const result = await facilitator.verify({ invoice: INVOICE }, makeRequirements());
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("invoice_not_paid");
  });

  it("rejects in-flight invoice", async () => {
    receiver = makeReceiver("in_flight");
    facilitator = new ExactBip122FacilitatorScheme({
      receiver,
      decodeBolt11Fn: () => makeDecoded(),
      nowFn: () => NOW_SEC * 1000,
    });
    const result = await facilitator.verify({ invoice: INVOICE }, makeRequirements());
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("invoice_in_flight");
  });

  it("rejects missing invoice in requirements", async () => {
    const result = await facilitator.verify({ invoice: INVOICE }, makeRequirements({ invoice: undefined }));
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("missing_invoice");
  });
});

describe("ExactBip122FacilitatorScheme.settle", () => {
  it("settles a paid invoice and prevents replay", async () => {
    const receiver = makeReceiver("paid");
    const facilitator = new ExactBip122FacilitatorScheme({
      receiver,
      decodeBolt11Fn: () => makeDecoded(),
      nowFn: () => NOW_SEC * 1000,
    });

    const settle1 = await facilitator.settle({ invoice: INVOICE }, makeRequirements());
    expect(settle1.settled).toBe(true);
    expect(settle1.paymentHash).toBe(PAYMENT_HASH);

    const settle2 = await facilitator.settle({ invoice: INVOICE }, makeRequirements());
    expect(settle2.settled).toBe(false);
    expect(settle2.reason).toBe("duplicate_settlement");
  });
});