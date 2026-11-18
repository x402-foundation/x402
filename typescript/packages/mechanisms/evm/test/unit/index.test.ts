import { describe, it, expect } from "vitest";
import { ExactEvmScheme } from "../../src";
import { ExactEvmScheme as ClientExactEvmScheme } from "../../src/exact/client/scheme";
import { ExactEvmScheme as ServerExactEvmScheme } from "../../src/exact/server/scheme";
import { ExactEvmScheme as FacilitatorExactEvmScheme } from "../../src/exact/facilitator/scheme";

describe("@x402/evm", () => {
  it("should export ExactEvmScheme", () => {
    expect(ExactEvmScheme).toBeDefined();
    expect(typeof ExactEvmScheme).toBe("function");
  });

  it("should create client instance", () => {
    const mockSigner = { address: () => "0x123", signTypedData: async () => new Uint8Array(65) };
    const client = new ClientExactEvmScheme(mockSigner as any);
    expect(client.scheme).toBe("exact");
  });

  it("should create server instance", () => {
    const server = new ServerExactEvmScheme();
    expect(server.scheme).toBe("exact");
  });

  it("should create facilitator instance", () => {
    const mockSigner = {
      readContract: async () => {},
      verifyTypedData: async () => true,
      writeContract: async () => "0xtx",
      waitForTransactionReceipt: async () => ({
        status: 1n,
        blockNumber: 1n,
        transactionHash: "0xtx",
      }),
      getBalance: async () => 1000000n,
      getChainID: async () => 8453n,
    };
    const facilitator = new FacilitatorExactEvmScheme(mockSigner as any);
    expect(facilitator.scheme).toBe("exact");
  });
});
