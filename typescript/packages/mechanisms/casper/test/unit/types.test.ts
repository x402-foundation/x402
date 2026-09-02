import { describe, expect, it } from "vitest";
import type {
  CasperAuthorizationState,
  ExactCasperAuthorization,
  ExactCasperPayload,
} from "../../src/types";

describe("Casper types", () => {
  it("accepts exact Casper payload shape", () => {
    const authorization: ExactCasperAuthorization = {
      from: "00" + "1".repeat(64),
      to: "00" + "2".repeat(64),
      value: "1000",
      validAfter: "1",
      validBefore: "2",
      nonce: "3".repeat(64),
    };
    const payload: ExactCasperPayload = {
      authorization,
      publicKey: "01" + "4".repeat(64),
      signature: "01" + "5".repeat(128),
    };
    const state: CasperAuthorizationState = "unused";

    expect(payload.authorization.value).toBe("1000");
    expect(state).toBe("unused");
  });
});
