import { describe, it, expect } from "vitest";
import { x402Facilitator } from "../../../src/facilitator/x402Facilitator";
import { SchemeNetworkFacilitator } from "../../../src/types/mechanisms";
import { PaymentPayload, PaymentRequirements } from "../../../src/types/payments";
import { VerifyResponse, SettleResponse } from "../../../src/types/facilitator";
import { Network } from "../../../src/types";
import { buildPaymentPayload, buildPaymentRequirements } from "../../mocks";

// Mock facilitator implementation
/**
 *
 */
class TestFacilitator implements SchemeNetworkFacilitator {
  public readonly scheme: string;
  public verifyCalls: Array<{ payload: PaymentPayload; requirements: PaymentRequirements }> = [];
  public settleCalls: Array<{ payload: PaymentPayload; requirements: PaymentRequirements }> = [];

  /**
   *
   * @param scheme
   * @param verifyResponse
   * @param settleResponse
   */
  constructor(
    scheme: string,
    private verifyResponse: VerifyResponse | Error = { isValid: true },
    private settleResponse: SettleResponse | Error = {
      success: true,
      transaction: "0xTestTx",
      network: "test:network",
    },
  ) {
    this.scheme = scheme;
  }

  getExtra(_: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   *
   * @param payload
   * @param requirements
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.verifyCalls.push({ payload, requirements });
    if (this.verifyResponse instanceof Error) {
      throw this.verifyResponse;
    }
    return this.verifyResponse;
  }

  /**
   *
   * @param payload
   * @param requirements
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.settleCalls.push({ payload, requirements });
    if (this.settleResponse instanceof Error) {
      throw this.settleResponse;
    }
    return this.settleResponse;
  }
}

describe("x402Facilitator", () => {
  describe("Construction", () => {
    it("should create empty instance", () => {
      const facilitator = new x402Facilitator();

      expect(facilitator).toBeDefined();
      expect(facilitator.getExtensions()).toEqual([]);
    });
  });

  describe("register", () => {
    it("should register scheme for current version (v2)", () => {
      const facilitator = new x402Facilitator();
      const testFacilitator = new TestFacilitator("test-scheme");

      const result = facilitator.register("test:network" as Network, testFacilitator);

      expect(result).toBe(facilitator); // Chaining
    });

    it("should return this for chaining", () => {
      const facilitator = new x402Facilitator();
      const scheme1 = new TestFacilitator("scheme1");
      const scheme2 = new TestFacilitator("scheme2");

      const result = facilitator
        .register("network1" as Network, scheme1)
        .register("network2" as Network, scheme2);

      expect(result).toBe(facilitator);
    });

    it("should support multiple schemes per network", () => {
      const facilitator = new x402Facilitator();
      const exactFacilitator = new TestFacilitator("exact");
      const intentFacilitator = new TestFacilitator("intent");

      facilitator
        .register("eip155:8453" as Network, exactFacilitator)
        .register("eip155:8453" as Network, intentFacilitator);

      // Should be able to verify with both schemes
      const payload1 = buildPaymentPayload({ x402Version: 2 });
      const req1 = buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network });

      const payload2 = buildPaymentPayload({ x402Version: 2 });
      const req2 = buildPaymentRequirements({
        scheme: "intent",
        network: "eip155:8453" as Network,
      });

      expect(() => facilitator.verify(payload1, req1)).not.toThrow();
      expect(() => facilitator.verify(payload2, req2)).not.toThrow();
    });

    it("should support same scheme on multiple networks", () => {
      const facilitator = new x402Facilitator();
      const evmFacilitator = new TestFacilitator("exact");
      const svmFacilitator = new TestFacilitator("exact");

      facilitator
        .register("eip155:8453" as Network, evmFacilitator)
        .register("solana:mainnet" as Network, svmFacilitator);

      const payload1 = buildPaymentPayload({ x402Version: 2 });
      const req1 = buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network });

      const payload2 = buildPaymentPayload({ x402Version: 2 });
      const req2 = buildPaymentRequirements({
        scheme: "exact",
        network: "solana:mainnet" as Network,
      });

      expect(() => facilitator.verify(payload1, req1)).not.toThrow();
      expect(() => facilitator.verify(payload2, req2)).not.toThrow();
    });
  });

  describe("registerV1", () => {
    it("should register scheme for v1", () => {
      const facilitator = new x402Facilitator();
      const testFacilitator = new TestFacilitator("test-scheme");

      const result = facilitator.registerV1("test-network" as Network, testFacilitator);

      expect(result).toBe(facilitator);
    });

    it("should handle v1 payment payloads", async () => {
      const facilitator = new x402Facilitator();
      const testFacilitator = new TestFacilitator("exact");

      facilitator.registerV1("base-sepolia" as Network, testFacilitator);

      const payload = buildPaymentPayload({ x402Version: 1 });
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "base-sepolia" as Network,
      });

      const result = await facilitator.verify(payload, requirements);

      expect(result.isValid).toBe(true);
      expect(testFacilitator.verifyCalls.length).toBe(1);
    });
  });

  describe("Extensions", () => {
    it("should register extension", () => {
      const facilitator = new x402Facilitator();

      const result = facilitator.registerExtension({ key: "bazaar" });

      expect(result).toBe(facilitator);
      expect(facilitator.getExtensions()).toEqual(["bazaar"]);
    });

    it("should register multiple extensions", () => {
      const facilitator = new x402Facilitator();

      facilitator.registerExtension({ key: "bazaar" }).registerExtension({ key: "sign_in_with_x" });

      expect(facilitator.getExtensions()).toEqual(["bazaar", "sign_in_with_x"]);
    });

    it("should not duplicate extensions", () => {
      const facilitator = new x402Facilitator();

      facilitator
        .registerExtension({ key: "bazaar" })
        .registerExtension({ key: "bazaar" })
        .registerExtension({ key: "bazaar" });

      expect(facilitator.getExtensions()).toEqual(["bazaar"]);
    });

    it("should return copy of extensions array", () => {
      const facilitator = new x402Facilitator();
      facilitator.registerExtension({ key: "bazaar" });

      const extensions = facilitator.getExtensions();
      extensions.push("modified");

      expect(facilitator.getExtensions()).toEqual(["bazaar"]);
    });

    it("should return empty array if no extensions registered", () => {
      const facilitator = new x402Facilitator();

      expect(facilitator.getExtensions()).toEqual([]);
    });
  });

  describe("verify", () => {
    it("should delegate to registered scheme facilitator", async () => {
      const facilitator = new x402Facilitator();
      const testFacilitator = new TestFacilitator("exact", { isValid: true });

      facilitator.register(["eip155:8453" as Network], testFacilitator);

      const payload = buildPaymentPayload({ x402Version: 2 });
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      const result = await facilitator.verify(payload, requirements);

      expect(result.isValid).toBe(true);
      expect(testFacilitator.verifyCalls.length).toBe(1);
      expect(testFacilitator.verifyCalls[0].payload).toBe(payload);
      expect(testFacilitator.verifyCalls[0].requirements).toBe(requirements);
    });

    it("should use pattern matching for network", async () => {
      const facilitator = new x402Facilitator();
      const testFacilitator = new TestFacilitator("exact");

      // Register with multiple EVM networks (will auto-derive eip155:* pattern)
      facilitator.register(["eip155:8453" as Network, "eip155:1" as Network], testFacilitator);

      const payload = buildPaymentPayload({ x402Version: 2 });
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      const result = await facilitator.verify(payload, requirements);

      expect(result.isValid).toBe(true);
      expect(testFacilitator.verifyCalls.length).toBe(1);
    });

    it("should throw if no facilitator registered for version", async () => {
      const facilitator = new x402Facilitator();

      const payload = buildPaymentPayload({ x402Version: 2 });
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      await expect(async () => await facilitator.verify(payload, requirements)).rejects.toThrow(
        "No facilitator registered for x402 version: 2",
      );
    });

    it("should throw if no facilitator registered for network/scheme", async () => {
      const facilitator = new x402Facilitator();
      const testFacilitator = new TestFacilitator("exact");

      facilitator.register(["eip155:8453" as Network], testFacilitator);

      const payload = buildPaymentPayload({ x402Version: 2 });
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "solana:mainnet" as Network, // Different network
      });

      await expect(async () => await facilitator.verify(payload, requirements)).rejects.toThrow(
        "No facilitator registered for scheme: exact and network: solana:mainnet",
      );
    });

    it("should propagate errors from scheme facilitator", async () => {
      const facilitator = new x402Facilitator();
      const errorFacilitator = new TestFacilitator(
        "exact",
        new Error("Verification failed: invalid signature"),
      );

      facilitator.register("eip155:8453" as Network, errorFacilitator);

      const payload = buildPaymentPayload({ x402Version: 2 });
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      await expect(async () => await facilitator.verify(payload, requirements)).rejects.toThrow(
        "Verification failed: invalid signature",
      );
    });
  });

  describe("settle", () => {
    it("should delegate to registered scheme facilitator", async () => {
      const facilitator = new x402Facilitator();
      const testFacilitator = new TestFacilitator("exact", undefined, {
        success: true,
        transaction: "0xTestTx",
        network: "eip155:8453",
      });

      facilitator.register(["eip155:8453" as Network], testFacilitator);

      const payload = buildPaymentPayload({ x402Version: 2 });
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      const result = await facilitator.settle(payload, requirements);

      expect(result.success).toBe(true);
      expect(testFacilitator.settleCalls.length).toBe(1);
      expect(testFacilitator.settleCalls[0].payload).toBe(payload);
      expect(testFacilitator.settleCalls[0].requirements).toBe(requirements);
    });

    it("should use pattern matching for network", async () => {
      const facilitator = new x402Facilitator();
      const testFacilitator = new TestFacilitator("exact");

      facilitator.register("solana:*" as Network, testFacilitator);

      const payload = buildPaymentPayload({ x402Version: 2 });
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as Network,
      });

      const result = await facilitator.settle(payload, requirements);

      expect(result.success).toBe(true);
      expect(testFacilitator.settleCalls.length).toBe(1);
    });

    it("should throw if no facilitator registered for version", async () => {
      const facilitator = new x402Facilitator();

      const payload = buildPaymentPayload({ x402Version: 2 });
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      await expect(async () => await facilitator.settle(payload, requirements)).rejects.toThrow(
        "No facilitator registered for x402 version: 2",
      );
    });

    it("should throw if no facilitator registered for network/scheme", async () => {
      const facilitator = new x402Facilitator();
      const testFacilitator = new TestFacilitator("exact");

      facilitator.register(["eip155:8453" as Network], testFacilitator);

      const payload = buildPaymentPayload({ x402Version: 2 });
      const requirements = buildPaymentRequirements({
        scheme: "intent", // Different scheme
        network: "eip155:8453" as Network,
      });

      await expect(async () => await facilitator.settle(payload, requirements)).rejects.toThrow(
        "No facilitator registered for scheme: intent and network: eip155:8453",
      );
    });

    it("should propagate errors from scheme facilitator", async () => {
      const facilitator = new x402Facilitator();
      const errorFacilitator = new TestFacilitator(
        "exact",
        undefined,
        new Error("Settlement failed: insufficient funds"),
      );

      facilitator.register("eip155:8453" as Network, errorFacilitator);

      const payload = buildPaymentPayload({ x402Version: 2 });
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      await expect(async () => await facilitator.settle(payload, requirements)).rejects.toThrow(
        "Settlement failed: insufficient funds",
      );
    });
  });

  describe("Version support", () => {
    it("should handle v1 and v2 separately", async () => {
      const facilitator = new x402Facilitator();
      const v1Facilitator = new TestFacilitator("exact", { isValid: true });
      const v2Facilitator = new TestFacilitator("exact", { isValid: true });

      facilitator.registerV1("eip155:8453" as Network, v1Facilitator);
      facilitator.register("eip155:8453" as Network, v2Facilitator);

      const v1Payload = buildPaymentPayload({ x402Version: 1 });
      const v2Payload = buildPaymentPayload({ x402Version: 2 });
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      const v1Result = await facilitator.verify(v1Payload, requirements);
      const v2Result = await facilitator.verify(v2Payload, requirements);

      expect(v1Result.isValid).toBe(true);
      expect(v2Result.isValid).toBe(true);
    });
  });

  describe("Network pattern matching", () => {
    it("should prefer exact match over pattern", async () => {
      const facilitator = new x402Facilitator();
      const exactFacilitator = new TestFacilitator("exact", { isValid: true });
      const patternFacilitator = new TestFacilitator("exact", { isValid: true });

      facilitator.register("eip155:8453" as Network, exactFacilitator);
      facilitator.register("eip155:*" as Network, patternFacilitator);

      const payload = buildPaymentPayload({ x402Version: 2 });
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      const result = await facilitator.verify(payload, requirements);

      expect(result.isValid).toBe(true);
      expect(exactFacilitator.verifyCalls.length).toBe(1);
      expect(patternFacilitator.verifyCalls.length).toBe(0);
    });
  });
});
