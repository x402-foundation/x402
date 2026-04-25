import { describe, it, expect } from "vitest";
import {
  assertAcceptsAllowlistedAfterExtensionEnrich,
  assertSettleResponseCoreUnchanged,
  isVacantStringField,
  snapshotPaymentRequirementsList,
  snapshotSettleResponseCore,
} from "../../../src/server/extensionResponsePolicy";
import { buildPaymentRequirements, buildSettleResponse } from "../../mocks";
import type { Network } from "../../../src/types";

describe("extensionResponsePolicy", () => {
  describe("isVacantStringField", () => {
    it("treats empty and whitespace-only strings as vacant", () => {
      expect(isVacantStringField("")).toBe(true);
      expect(isVacantStringField("   ")).toBe(true);
      expect(isVacantStringField("0xabc")).toBe(false);
    });
  });

  describe("assertAcceptsAllowlistedAfterExtensionEnrich", () => {
    it("allows filling vacant payTo, amount, and asset", () => {
      const baseline = snapshotPaymentRequirementsList([
        buildPaymentRequirements({
          payTo: "",
          amount: "",
          asset: "",
        }),
      ]);
      const current = snapshotPaymentRequirementsList(baseline);
      current[0].payTo = "0xnew";
      current[0].amount = "1";
      current[0].asset = "USDC";
      expect(() =>
        assertAcceptsAllowlistedAfterExtensionEnrich(baseline, current, "ext"),
      ).not.toThrow();
    });

    it("rejects changing scheme", () => {
      const baseline = snapshotPaymentRequirementsList([buildPaymentRequirements()]);
      const current = snapshotPaymentRequirementsList(baseline);
      current[0].scheme = "other";
      expect(() => assertAcceptsAllowlistedAfterExtensionEnrich(baseline, current, "ext")).toThrow(
        /scheme\/network/,
      );
    });

    it("rejects changing amount when baseline amount was set", () => {
      const baseline = snapshotPaymentRequirementsList([
        buildPaymentRequirements({ amount: "1000" }),
      ]);
      const current = snapshotPaymentRequirementsList(baseline);
      current[0].amount = "999";
      expect(() => assertAcceptsAllowlistedAfterExtensionEnrich(baseline, current, "ext")).toThrow(
        /amount.*vacant/,
      );
    });

    it("rejects removing an extra key from baseline", () => {
      const baseline = snapshotPaymentRequirementsList([
        buildPaymentRequirements({ extra: { k: 1 } }),
      ]);
      const current = snapshotPaymentRequirementsList(baseline);
      current[0].extra = {};
      expect(() => assertAcceptsAllowlistedAfterExtensionEnrich(baseline, current, "ext")).toThrow(
        /extra\["k"\]/,
      );
    });

    it("rejects changing an extra value from baseline", () => {
      const baseline = snapshotPaymentRequirementsList([
        buildPaymentRequirements({ extra: { k: 1 } }),
      ]);
      const current = snapshotPaymentRequirementsList(baseline);
      current[0].extra = { ...current[0].extra, k: 2 };
      expect(() => assertAcceptsAllowlistedAfterExtensionEnrich(baseline, current, "ext")).toThrow(
        /extra\["k"\]/,
      );
    });

    it("allows adding new extra keys", () => {
      const baseline = snapshotPaymentRequirementsList([
        buildPaymentRequirements({ extra: { k: 1 } }),
      ]);
      const current = snapshotPaymentRequirementsList(baseline);
      current[0].extra = { ...current[0].extra, k: 1, newKey: true };
      expect(() =>
        assertAcceptsAllowlistedAfterExtensionEnrich(baseline, current, "ext"),
      ).not.toThrow();
    });

    it("detects in-place mutation of nested extra values (deep snapshot)", () => {
      const baseline = snapshotPaymentRequirementsList([
        buildPaymentRequirements({ extra: { nested: { b: "c" } } }),
      ]);
      const current = snapshotPaymentRequirementsList(baseline);
      (current[0].extra as { nested: { b: string } }).nested.b = "mutated";
      expect(() => assertAcceptsAllowlistedAfterExtensionEnrich(baseline, current, "ext")).toThrow(
        /extra\["nested"\]/,
      );
    });
  });

  describe("assertSettleResponseCoreUnchanged", () => {
    it("passes when only extensions change", () => {
      const base = buildSettleResponse({
        success: true,
        transaction: "0xtx",
        network: "eip155:8453" as Network,
      });
      const snap = snapshotSettleResponseCore(base);
      base.extensions = { a: 1 };
      expect(() => assertSettleResponseCoreUnchanged(snap, base, "ext")).not.toThrow();
    });

    it("throws when transaction changes", () => {
      const base = buildSettleResponse({
        success: true,
        transaction: "0xtx",
        network: "eip155:8453" as Network,
      });
      const snap = snapshotSettleResponseCore(base);
      base.transaction = "0xother";
      expect(() => assertSettleResponseCoreUnchanged(snap, base, "ext")).toThrow(/transaction/);
    });
  });
});
