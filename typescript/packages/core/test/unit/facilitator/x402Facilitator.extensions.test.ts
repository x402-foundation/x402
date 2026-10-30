import { describe, it, expect, vi } from "vitest";
import { x402Facilitator } from "../../../src/facilitator/x402Facilitator";
import {
  FacilitatorExtension,
  FacilitatorSettleResultContext,
} from "../../../src/types/extensions";
import {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
} from "../../../src/types";
import { SchemeNetworkFacilitator } from "../../../src/types/mechanisms";

// ---------------------------------------------------------------------------
// Minimal mock scheme facilitator
// ---------------------------------------------------------------------------

class MockSchemeFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "eip155:*";

  constructor(
    private settleFn?: (
      payload: PaymentPayload,
      requirements: PaymentRequirements,
    ) => Promise<SettleResponse>,
  ) {}

  getExtra(_: string): Record<string, unknown> | undefined {
    return undefined;
  }

  getSigners(_: string): string[] {
    return [];
  }

  async verify(
    _payload: PaymentPayload,
    _requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return { isValid: true };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    if (this.settleFn) {
      return this.settleFn(payload, requirements);
    }
    return {
      success: true,
      transaction: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      network: requirements.network,
      payer: "0xPayer",
    };
  }
}

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

const buildPaymentPayload = (): PaymentPayload => ({
  x402Version: 2,
  payload: {},
  accepted: {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0xUSDC",
    amount: "1000000",
    payTo: "0xRecipient",
    maxTimeoutSeconds: 300,
    extra: {},
  },
  resource: {
    url: "https://example.com/resource",
    description: "Test resource",
    mimeType: "application/json",
  },
});

const buildPaymentRequirements = (): PaymentRequirements => ({
  scheme: "exact",
  network: "eip155:8453",
  asset: "0xUSDC",
  amount: "1000000",
  payTo: "0xRecipient",
  maxTimeoutSeconds: 300,
  extra: {},
});

const buildFacilitator = (
  settleFn?: (p: PaymentPayload, r: PaymentRequirements) => Promise<SettleResponse>,
) => {
  const facilitator = new x402Facilitator();
  facilitator.register("eip155:8453", new MockSchemeFacilitator(settleFn));
  return facilitator;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("x402Facilitator - FacilitatorExtension.enrichSettleResponse hooks", () => {
  // Test 1: Register extension — extension is stored by key
  it("should store a registered extension by key", () => {
    const facilitator = buildFacilitator();

    const ext: FacilitatorExtension = {
      key: "test-ext",
      enrichSettleResponse: async () => ({ foo: "bar" }),
    };

    facilitator.registerExtension(ext);

    expect(facilitator.getExtension("test-ext")).toBe(ext);
    expect(facilitator.getExtensions()).toContain("test-ext");
  });

  // Test 2: enrichSettleResponse called on success, with correct context
  it("should call enrichSettleResponse after successful settlement with correct context", async () => {
    const facilitator = buildFacilitator();

    let capturedContext: FacilitatorSettleResultContext | undefined;

    facilitator.registerExtension({
      key: "ctx-ext",
      enrichSettleResponse: async ctx => {
        capturedContext = ctx;
        return undefined;
      },
    });

    const payload = buildPaymentPayload();
    const requirements = buildPaymentRequirements();

    await facilitator.settle(payload, requirements);

    expect(capturedContext).toBeDefined();
    expect(capturedContext!.paymentPayload).toEqual(payload);
    expect(capturedContext!.requirements).toEqual(requirements);
    expect(capturedContext!.result.success).toBe(true);
  });

  // Test 3: enrichSettleResponse modifies extensions field
  it("should add extension data to SettleResponse.extensions[key]", async () => {
    const facilitator = buildFacilitator();

    facilitator.registerExtension({
      key: "my-ext",
      enrichSettleResponse: async () => ({ signed: true, value: 42 }),
    });

    const result = await facilitator.settle(buildPaymentPayload(), buildPaymentRequirements());

    expect(result.extensions).toBeDefined();
    expect(result.extensions!["my-ext"]).toEqual({ signed: true, value: 42 });
  });

  // Test 4: Multiple extensions — both hooks run in order
  it("should call all registered enrichSettleResponse hooks in registration order", async () => {
    const facilitator = buildFacilitator();
    const callOrder: string[] = [];

    facilitator.registerExtension({
      key: "ext-alpha",
      enrichSettleResponse: async () => {
        callOrder.push("alpha");
        return { from: "alpha" };
      },
    });

    facilitator.registerExtension({
      key: "ext-beta",
      enrichSettleResponse: async () => {
        callOrder.push("beta");
        return { from: "beta" };
      },
    });

    const result = await facilitator.settle(buildPaymentPayload(), buildPaymentRequirements());

    expect(callOrder).toEqual(["alpha", "beta"]);
    expect(result.extensions!["ext-alpha"]).toEqual({ from: "alpha" });
    expect(result.extensions!["ext-beta"]).toEqual({ from: "beta" });
  });

  // Test 5: Extension error doesn't break settlement
  it("should not fail settlement when an extension hook throws", async () => {
    const facilitator = buildFacilitator();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    facilitator.registerExtension({
      key: "bad-ext",
      enrichSettleResponse: async () => {
        throw new Error("Extension signing failed");
      },
    });

    const result = await facilitator.settle(buildPaymentPayload(), buildPaymentRequirements());

    expect(result.success).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("bad-ext"), expect.any(Error));

    consoleSpy.mockRestore();
  });

  // Test 6: Extension without enrichSettleResponse — SettleResponse unchanged
  it("should leave extensions undefined when registered extension has no enrichSettleResponse", async () => {
    const facilitator = buildFacilitator();

    // Extension that only has key — no enrichSettleResponse hook
    facilitator.registerExtension({ key: "no-hook-ext" });

    const result = await facilitator.settle(buildPaymentPayload(), buildPaymentRequirements());

    expect(result.extensions).toBeUndefined();
  });

  // Test 7: Failed settlement — hooks not called
  it("should not call enrichSettleResponse when settlement throws", async () => {
    const facilitator = buildFacilitator(async () => {
      throw new Error("On-chain settlement failed");
    });

    let hookCalled = false;

    facilitator.registerExtension({
      key: "should-not-run",
      enrichSettleResponse: async () => {
        hookCalled = true;
        return { data: "oops" };
      },
    });

    await expect(
      facilitator.settle(buildPaymentPayload(), buildPaymentRequirements()),
    ).rejects.toThrow("On-chain settlement failed");

    expect(hookCalled).toBe(false);
  });

  // Test 8: Extensions field preserved through JSON serialization
  it("should preserve extensions field through JSON round-trip", async () => {
    const facilitator = buildFacilitator();

    facilitator.registerExtension({
      key: "serial-ext",
      enrichSettleResponse: async () => ({
        attestation: { format: "eip712", signature: "0xdeadbeef" },
      }),
    });

    const result = await facilitator.settle(buildPaymentPayload(), buildPaymentRequirements());

    const serialized = JSON.stringify(result);
    const parsed: SettleResponse = JSON.parse(serialized);

    expect(parsed.extensions).toBeDefined();
    expect(parsed.extensions!["serial-ext"]).toEqual({
      attestation: { format: "eip712", signature: "0xdeadbeef" },
    });
  });

  // Test 9: Context contains correct txHash and network from the settlement result
  it("should pass the correct transaction hash and network from settlement result in context", async () => {
    const expectedTxHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const expectedNetwork = "eip155:8453";

    const facilitator = buildFacilitator(async (_payload, req) => ({
      success: true,
      transaction: expectedTxHash,
      network: req.network,
      payer: "0xPayer",
    }));

    let capturedTxHash: string | undefined;
    let capturedNetwork: string | undefined;

    facilitator.registerExtension({
      key: "ctx-check",
      enrichSettleResponse: async ctx => {
        capturedTxHash = ctx.result.transaction;
        capturedNetwork = ctx.result.network;
        return undefined;
      },
    });

    await facilitator.settle(buildPaymentPayload(), buildPaymentRequirements());

    expect(capturedTxHash).toBe(expectedTxHash);
    expect(capturedNetwork).toBe(expectedNetwork);
  });

  // Test 10 (integration-style): end-to-end — extension adds data to settle response
  it("end-to-end: registered extension adds extensions field to /settle response shape", async () => {
    const facilitator = buildFacilitator();

    facilitator.registerExtension({
      key: "test-ext",
      enrichSettleResponse: async ctx => ({
        foo: "bar",
        txHash: ctx.result.transaction,
      }),
    });

    const result = await facilitator.settle(buildPaymentPayload(), buildPaymentRequirements());

    expect(result.success).toBe(true);
    expect(result.extensions).toBeDefined();
    expect(result.extensions!["test-ext"]).toMatchObject({ foo: "bar" });
    expect(typeof (result.extensions!["test-ext"] as { txHash: string }).txHash).toBe("string");
  });

  // Additional: enrichSettleResponse returning undefined does not create empty extensions key
  it("should not set extensions[key] when enrichSettleResponse returns undefined", async () => {
    const facilitator = buildFacilitator();

    facilitator.registerExtension({
      key: "skip-ext",
      enrichSettleResponse: async () => undefined,
    });

    const result = await facilitator.settle(buildPaymentPayload(), buildPaymentRequirements());

    expect(result.extensions?.["skip-ext"]).toBeUndefined();
  });

  // Additional: enrichSettleResponse is not called after a failed (success: false) scheme response
  // (the scheme returns success:false — note: currently x402Facilitator doesn't distinguish
  //  success:false from the scheme vs thrown errors, so hooks run regardless for non-throw results)
  it("should call enrichSettleResponse even when scheme returns success:false (scheme-level failure)", async () => {
    const facilitator = buildFacilitator(async (_p, req) => ({
      success: false,
      transaction: "",
      network: req.network,
      errorReason: "insufficient_funds",
    }));

    let hookCalled = false;

    facilitator.registerExtension({
      key: "failure-ext",
      enrichSettleResponse: async ctx => {
        hookCalled = true;
        // Extension can inspect ctx.result.success and choose to skip
        if (!ctx.result.success) return undefined;
        return { data: "never" };
      },
    });

    const result = await facilitator.settle(buildPaymentPayload(), buildPaymentRequirements());

    // Settlement completed (did not throw), extension was called
    expect(hookCalled).toBe(true);
    expect(result.success).toBe(false);
    // Extension returned undefined (skipped) for failed settlement
    expect(result.extensions?.["failure-ext"]).toBeUndefined();
  });
});
