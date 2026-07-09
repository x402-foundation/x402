import { describe, it, expect } from "vitest";
import type { ExactSuiPayload, SuiOutput, ExactSuiExtra } from "../../src/types";

describe("Sui Types", () => {
  describe("ExactSuiPayload", () => {
    it("accepts a signature + transaction pair", () => {
      const payload: ExactSuiPayload = { signature: "c2ln", transaction: "dHg=" };
      expect(typeof payload.signature).toBe("string");
      expect(typeof payload.transaction).toBe("string");
    });
  });

  describe("SuiOutput", () => {
    it("carries a recipient and a decimal-string amount", () => {
      const o: SuiOutput = { to: "0x1", amount: "10000" };
      expect(o.to).toBe("0x1");
      expect(o.amount).toBe("10000");
    });
  });

  describe("ExactSuiExtra", () => {
    it("allows optional outputs and assetTransferMethod", () => {
      const withOutputs: ExactSuiExtra = {
        outputs: [{ to: "0x1", amount: "9000" }],
        assetTransferMethod: "address-balance",
      };
      const empty: ExactSuiExtra = {};
      expect(withOutputs.outputs).toHaveLength(1);
      expect(empty.outputs).toBeUndefined();
      expect(empty.assetTransferMethod).toBeUndefined();
    });
  });
});
