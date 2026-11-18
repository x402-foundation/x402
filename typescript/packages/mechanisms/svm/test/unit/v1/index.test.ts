import { describe, it, expect } from "vitest";
import { ExactSvmSchemeV1 } from "../../../src/v1";

describe("@x402/svm/v1", () => {
  it("should export ExactSvmSchemeV1", () => {
    expect(ExactSvmSchemeV1).toBeDefined();
    expect(typeof ExactSvmSchemeV1).toBe("function");
  });

  it("should export ExactSvmSchemeV1", () => {
    expect(ExactSvmSchemeV1).toBeDefined();
    expect(typeof ExactSvmSchemeV1).toBe("function");
  });

  it("should create ExactSvmSchemeV1 instance with correct scheme", () => {
    const mockSigner = {
      address: "9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ" as never,
      signTransactions: async () => [] as never,
    };

    const client = new ExactSvmSchemeV1(mockSigner);
    expect(client.scheme).toBe("exact");
  });

  it("should create ExactSvmSchemeV1 instance with correct scheme", () => {
    const mockSigner = {
      address: "FacilitatorAddress1111111111111111111" as never,
      signTransactions: async () => [] as never,
      signMessages: async () => [] as never,
      getRpcForNetwork: () =>
        ({
          getBalance: async () => BigInt(0),
        }) as never,
    };

    const facilitator = new ExactSvmSchemeV1(mockSigner as never);
    expect(facilitator.scheme).toBe("exact");
  });
});
