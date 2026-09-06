import { describe, expect, it } from "vitest";
import { interpretSettlementOutcome } from "../../src/signers/facilitatorNearSigner";

describe("near reference facilitator signer outcome classification", () => {
  it("requires a successful receipt executed by the token contract", () => {
    const outcome = {
      status: { SuccessValue: "" },
      receipts_outcome: [
        { outcome: { executor_id: "alice.testnet", status: { SuccessValue: "" } } },
        { outcome: { executor_id: "usdc.testnet", status: { SuccessValue: "" } } },
      ],
    };

    expect(interpretSettlementOutcome(outcome, "usdc.testnet")).toEqual({
      kind: "success",
      value: "",
    });
  });

  it("reports failure when any final receipt failed", () => {
    const outcome = {
      status: { SuccessValue: "" },
      receipts_outcome: [
        {
          outcome: {
            executor_id: "usdc.testnet",
            status: { Failure: { ActionError: "NotEnoughBalance" } },
          },
        },
      ],
    };

    const result = interpretSettlementOutcome(outcome, "usdc.testnet");
    expect(result.kind).toBe("failure");
    expect(result.error).toContain("NotEnoughBalance");
  });

  it("does not treat outer transaction success as inner transfer success", () => {
    const outcome = {
      status: { SuccessValue: "" },
      receipts_outcome: [
        { outcome: { executor_id: "relayer.testnet", status: { SuccessValue: "" } } },
      ],
    };

    expect(interpretSettlementOutcome(outcome, "usdc.testnet")).toEqual({
      kind: "failure",
      error: "inner_ft_transfer_receipt_not_successful",
    });
  });

  it("reports outer transaction failure before inspecting receipts", () => {
    const outcome = {
      status: { Failure: { ActionError: "DelegateActionInvalidNonce" } },
      receipts_outcome: [
        { outcome: { executor_id: "usdc.testnet", status: { SuccessValue: "" } } },
      ],
    };

    const result = interpretSettlementOutcome(outcome, "usdc.testnet");
    expect(result.kind).toBe("failure");
    expect(result.error).toContain("DelegateActionInvalidNonce");
  });
});
