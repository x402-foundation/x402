import { describe, expect, it } from "vitest";
import { SettleError, VerifyError } from "../../../src/types/facilitator";
import { Network } from "../../../src/types";

const network = "eip155:8453" as Network;

describe("VerifyError", () => {
  it("joins reason and message when both are present", () => {
    const error = new VerifyError(402, {
      isValid: false,
      invalidReason: "invalid_payload",
      invalidMessage: "bad signature",
      payer: "0xabc",
    });

    expect(error.message).toBe("invalid_payload: bad signature");
    expect(error.name).toBe("VerifyError");
    expect(error.statusCode).toBe(402);
    expect(error.invalidReason).toBe("invalid_payload");
    expect(error.invalidMessage).toBe("bad signature");
    expect(error.payer).toBe("0xabc");
  });

  it("uses a fallback reason when the verify response omits details", () => {
    const error = new VerifyError(400, { isValid: false });

    expect(error.message).toBe("unknown reason");
    expect(error.invalidReason).toBeUndefined();
    expect(error.invalidMessage).toBeUndefined();
    expect(error.payer).toBeUndefined();
  });
});

describe("SettleError", () => {
  it("joins reason and message when both are present", () => {
    const error = new SettleError(402, {
      success: false,
      errorReason: "settlement_pending",
      errorMessage: "still pending",
      payer: "0xabc",
      transaction: "0x1",
      network,
    });

    expect(error.message).toBe("settlement_pending: still pending");
    expect(error.name).toBe("SettleError");
    expect(error.statusCode).toBe(402);
    expect(error.errorReason).toBe("settlement_pending");
    expect(error.errorMessage).toBe("still pending");
    expect(error.payer).toBe("0xabc");
    expect(error.transaction).toBe("0x1");
    expect(error.network).toBe(network);
  });

  it("uses a fallback reason when the settle response omits details", () => {
    const error = new SettleError(500, {
      success: false,
      transaction: "",
      network,
    });

    expect(error.message).toBe("unknown reason");
    expect(error.errorReason).toBeUndefined();
    expect(error.errorMessage).toBeUndefined();
    expect(error.payer).toBeUndefined();
  });
});
