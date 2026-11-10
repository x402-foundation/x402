import { describe, it, expect } from "vitest";
import type { PaymentPayload } from "@x402/core";
import { computeRequestFingerprint, isRequestBindingConflict } from "../src/payment-identifier";

const basePayload = (): PaymentPayload => ({
  x402Version: 2,
  resource: { url: "https://example.com/weather" },
  accepted: {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0xUSDC",
    amount: "1000",
    payTo: "0xMerchant",
    maxTimeoutSeconds: 300,
    extra: {},
  },
  payload: {},
});

describe("computeRequestFingerprint", () => {
  it("produces the same fingerprint for identical payment terms", () => {
    const a = computeRequestFingerprint(basePayload());
    const b = computeRequestFingerprint(basePayload());
    expect(a).toBe(b);
  });

  it("is unaffected by property order in the source objects", () => {
    const reordered: PaymentPayload = {
      payload: {},
      accepted: {
        extra: {},
        payTo: "0xMerchant",
        amount: "1000",
        asset: "0xUSDC",
        network: "eip155:84532",
        scheme: "exact",
        maxTimeoutSeconds: 300,
      },
      resource: { url: "https://example.com/weather" },
      x402Version: 2,
    };
    expect(computeRequestFingerprint(reordered)).toBe(computeRequestFingerprint(basePayload()));
  });

  it("changes when amount differs", () => {
    const changed = basePayload();
    changed.accepted.amount = "2000";
    expect(computeRequestFingerprint(changed)).not.toBe(computeRequestFingerprint(basePayload()));
  });

  it("changes when payTo differs", () => {
    const changed = basePayload();
    changed.accepted.payTo = "0xAttacker";
    expect(computeRequestFingerprint(changed)).not.toBe(computeRequestFingerprint(basePayload()));
  });

  it("changes when asset differs", () => {
    const changed = basePayload();
    changed.accepted.asset = "0xOtherToken";
    expect(computeRequestFingerprint(changed)).not.toBe(computeRequestFingerprint(basePayload()));
  });

  it("changes when scheme differs", () => {
    const changed = basePayload();
    changed.accepted.scheme = "upto";
    expect(computeRequestFingerprint(changed)).not.toBe(computeRequestFingerprint(basePayload()));
  });

  it("changes when network differs", () => {
    const changed = basePayload();
    changed.accepted.network = "eip155:1";
    expect(computeRequestFingerprint(changed)).not.toBe(computeRequestFingerprint(basePayload()));
  });

  it("changes when the resource url differs", () => {
    const changed = basePayload();
    changed.resource = { url: "https://example.com/other-resource" };
    expect(computeRequestFingerprint(changed)).not.toBe(computeRequestFingerprint(basePayload()));
  });

  it("does not crash when resource is absent", () => {
    const changed = basePayload();
    delete changed.resource;
    expect(() => computeRequestFingerprint(changed)).not.toThrow();
  });

  it("changes when the HTTP method context differs", () => {
    const a = computeRequestFingerprint(basePayload(), { method: "GET" });
    const b = computeRequestFingerprint(basePayload(), { method: "POST" });
    expect(a).not.toBe(b);
  });

  it("changes when the operationId context differs", () => {
    const a = computeRequestFingerprint(basePayload(), { operationId: "order_1" });
    const b = computeRequestFingerprint(basePayload(), { operationId: "order_2" });
    expect(a).not.toBe(b);
  });

  it("is stable when context is omitted entirely", () => {
    const a = computeRequestFingerprint(basePayload());
    const b = computeRequestFingerprint(basePayload(), {});
    expect(a).toBe(b);
  });
});

describe("isRequestBindingConflict", () => {
  it("returns false for matching fingerprints", () => {
    const fp = computeRequestFingerprint(basePayload());
    expect(isRequestBindingConflict(fp, fp)).toBe(false);
  });

  it("returns true for a changed amount (the A52-class bug this guards against)", () => {
    const stored = computeRequestFingerprint(basePayload());
    const replay = basePayload();
    replay.accepted.amount = "1";
    const current = computeRequestFingerprint(replay);
    expect(isRequestBindingConflict(stored, current)).toBe(true);
  });
});
