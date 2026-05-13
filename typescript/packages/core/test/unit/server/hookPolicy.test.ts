import { describe, it, expect } from "vitest";
import {
  assertAcceptsAllowlistedAfterExtensionEnrich,
  assertAdditivePayloadEnrichment,
  assertAdditiveSettlementExtra,
  assertSettleResponseCoreUnchanged,
  isVacantStringField,
  mergeAdditiveSettlementExtra,
  snapshotPaymentRequirementsList,
  snapshotSettleResponseCore,
} from "../../../src/server/hookPolicy";
import { buildPaymentRequirements, buildSettleResponse } from "../../mocks";
import type { Network } from "../../../src/types";

describe("hookPolicy", () => {
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

  describe("assertAdditivePayloadEnrichment", () => {
    it("allows adding new payload fields", () => {
      expect(() =>
        assertAdditivePayloadEnrichment(
          { clientField: "client" },
          { serverField: "server" },
          "scheme test",
        ),
      ).not.toThrow();
    });

    it("rejects overwriting payload fields", () => {
      expect(() =>
        assertAdditivePayloadEnrichment(
          { clientField: "client" },
          { clientField: "server" },
          "scheme test",
        ),
      ).toThrow(/clientField/);
    });
  });

  describe("assertAdditiveSettlementExtra", () => {
    it("allows adding new settlement extra fields", () => {
      expect(() =>
        assertAdditiveSettlementExtra(
          { facilitatorField: "facilitator" },
          { schemeField: "scheme" },
          "scheme test",
        ),
      ).not.toThrow();
    });

    it("allows adding nested settlement extra fields", () => {
      expect(() =>
        assertAdditiveSettlementExtra(
          {
            channelState: {
              channelId: "0xchannel",
              balance: "1000",
            },
          },
          {
            channelState: {
              chargedCumulativeAmount: "200",
            },
          },
          "scheme test",
        ),
      ).not.toThrow();
    });

    it("rejects overwriting settlement extra fields", () => {
      expect(() =>
        assertAdditiveSettlementExtra(
          { facilitatorField: "facilitator" },
          { facilitatorField: "scheme" },
          "scheme test",
        ),
      ).toThrow(/facilitatorField/);
    });

    it("rejects overwriting nested settlement extra fields", () => {
      expect(() =>
        assertAdditiveSettlementExtra(
          {
            channelState: {
              balance: "1000",
            },
          },
          {
            channelState: {
              balance: "2000",
            },
          },
          "scheme test",
        ),
      ).toThrow(/channelState.*balance/);
    });
  });

  describe("mergeAdditiveSettlementExtra", () => {
    it("merges nested settlement extra fields", () => {
      expect(
        mergeAdditiveSettlementExtra(
          {
            channelState: {
              channelId: "0xchannel",
              balance: "1000",
            },
          },
          {
            chargedAmount: "100",
            channelState: {
              chargedCumulativeAmount: "200",
            },
          },
        ),
      ).toEqual({
        chargedAmount: "100",
        channelState: {
          channelId: "0xchannel",
          balance: "1000",
          chargedCumulativeAmount: "200",
        },
      });
    });
  });
});
