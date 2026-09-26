/**
 * Server (merchant) scheme: price parsing, 402 enhancement, and the
 * asset/instrumentId consistency guard.
 */
import { describe, it, expect } from "vitest";
import type { PaymentRequirements, SupportedKind } from "@x402/core/types";
import {
  ExactCantonScheme,
  assertAssetInstrumentConsistency,
} from "../../src/exact/server/scheme.js";

const NETWORK = "canton:mainnet" as const;
const DSO = "DSO::1220" + "aa".repeat(32);
const FAC = "facilitator::1220" + "ff".repeat(32);

const baseReqs = (): PaymentRequirements => ({
  scheme: "exact",
  network: NETWORK,
  amount: "100000000",
  asset: "CC",
  payTo: "merchant::1220" + "bb".repeat(32),
  maxTimeoutSeconds: 60,
  extra: { instrumentId: { admin: DSO, id: "Amulet" } },
});

const supported = (): SupportedKind => ({
  x402Version: 2,
  scheme: "exact",
  network: NETWORK,
  extra: { feePayer: FAC, synchronizerId: "global-domain::1220test" },
});

describe("server scheme", () => {
  const s = new ExactCantonScheme();

  it("declares the transfer-factory authorization flow", () => {
    expect(s.scheme).toBe("exact");
    expect(s.defaultAssetTransferMethod).toBe("transfer-factory");
    expect(s.paymentFlows["transfer-factory"].default).toBe("authorization");
  });

  it("getAssetDecimals returns 10 for Canton Coin", () => {
    expect(s.getAssetDecimals("CC", NETWORK)).toBe(10);
    expect(s.getAssetDecimals("SOMETHING", NETWORK)).toBeUndefined();
  });

  it("parsePrice accepts an explicit AssetAmount", async () => {
    const a = await s.parsePrice({ amount: "100000000", asset: "CC" }, NETWORK);
    expect(a).toEqual({ amount: "100000000", asset: "CC", extra: {} });
  });

  it("parsePrice rejects a dollar-string (no Canton Coin peg)", async () => {
    await expect(s.parsePrice("$0.10", NETWORK)).rejects.toThrow(/explicit AssetAmount/);
  });

  it("enhancePaymentRequirements merges feePayer + synchronizerId + method", async () => {
    const out = await s.enhancePaymentRequirements(baseReqs(), supported(), []);
    expect(out.extra.feePayer).toBe(FAC);
    expect(out.extra.synchronizerId).toBe("global-domain::1220test");
    expect(out.extra.assetTransferMethod).toBe("transfer-factory");
  });
});

describe("assertAssetInstrumentConsistency", () => {
  it("no-op for a symbolic asset", () => {
    expect(() => assertAssetInstrumentConsistency(baseReqs())).not.toThrow();
  });

  it("passes when a structured asset matches instrumentId", () => {
    const r = baseReqs();
    r.asset = `${DSO}::Amulet`;
    expect(() => assertAssetInstrumentConsistency(r)).not.toThrow();
  });

  it("throws when a structured asset disagrees with instrumentId", () => {
    const r = baseReqs();
    r.asset = "wrong::Amulet";
    expect(() => assertAssetInstrumentConsistency(r)).toThrow(/disagrees/);
  });
});
