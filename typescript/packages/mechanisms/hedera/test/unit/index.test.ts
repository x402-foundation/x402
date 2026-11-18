import { describe, expect, it } from "vitest";
import { createClientHederaSigner, ExactHederaPayloadV2 } from "../../src";
import { ExactHederaScheme as ExactHederaClient } from "../../src/exact/client/scheme";
import { ExactHederaScheme as ExactHederaServer } from "../../src/exact/server/scheme";
import { ExactHederaScheme as ExactHederaFacilitator } from "../../src/exact/facilitator/scheme";

describe("@x402/hedera", () => {
  it("exports exact payload type shape", () => {
    const payload: ExactHederaPayloadV2 = { transaction: "dGVzdA==" };
    expect(payload.transaction).toBe("dGVzdA==");
  });

  it("exports all scheme classes", () => {
    expect(ExactHederaClient).toBeDefined();
    expect(ExactHederaServer).toBeDefined();
    expect(ExactHederaFacilitator).toBeDefined();
  });

  it("exports signer helpers", () => {
    expect(createClientHederaSigner).toBeTypeOf("function");
  });
});
