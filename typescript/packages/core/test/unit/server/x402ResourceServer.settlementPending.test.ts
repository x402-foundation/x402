import { describe, it, expect, vi } from "vitest";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import {
  MockFacilitatorClient,
  buildPaymentPayload,
  buildPaymentRequirements,
  buildSettleResponse,
  buildSupportedResponse,
} from "../../mocks";
import { SettleError } from "../../../src/types/facilitator";

/**
 * Tests for the single automatic settle retry on a `settlement_pending`
 * outcome (mirrors Go's `settleWithPendingRetry`/`isRetryableSettlementPending`),
 * and for the success:false → onSettleFailure routing fix.
 */
describe("x402ResourceServer settlePayment - settlement_pending retry", () => {
  it("retries exactly once on a returned settlement_pending failure and returns the retried success", async () => {
    const mockClient = new MockFacilitatorClient(buildSupportedResponse());
    const settleSpy = vi
      .spyOn(mockClient, "settle")
      .mockResolvedValueOnce(
        buildSettleResponse({
          success: false,
          errorReason: "settlement_pending",
          transaction: "0xpendingtx",
        }),
      )
      .mockResolvedValueOnce(buildSettleResponse({ success: true, transaction: "0xpendingtx" }));

    const server = new x402ResourceServer(mockClient);
    const payload = buildPaymentPayload();
    const requirements = buildPaymentRequirements();

    const result = await server.settlePayment(payload, requirements);

    expect(settleSpy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0xpendingtx");
  });

  it("retries exactly once on a thrown settlement_pending SettleError and returns the retried success", async () => {
    const mockClient = new MockFacilitatorClient(buildSupportedResponse());
    const pendingError = new SettleError(402, {
      success: false,
      errorReason: "settlement_pending",
      transaction: "0xpendingtx",
      network: buildPaymentRequirements().network,
    });
    const settleSpy = vi
      .spyOn(mockClient, "settle")
      .mockRejectedValueOnce(pendingError)
      .mockResolvedValueOnce(buildSettleResponse({ success: true, transaction: "0xpendingtx" }));

    const server = new x402ResourceServer(mockClient);
    const payload = buildPaymentPayload();
    const requirements = buildPaymentRequirements();

    const result = await server.settlePayment(payload, requirements);

    expect(settleSpy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });

  it("does not retry on a non-pending failure reason", async () => {
    const mockClient = new MockFacilitatorClient(buildSupportedResponse());
    const settleSpy = vi.spyOn(mockClient, "settle").mockResolvedValueOnce(
      buildSettleResponse({
        success: false,
        errorReason: "invalid_signature",
        transaction: "",
      }),
    );

    const server = new x402ResourceServer(mockClient);
    const result = await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_signature");
  });

  it("does not retry on a pending failure with an empty transaction hash", async () => {
    const mockClient = new MockFacilitatorClient(buildSupportedResponse());
    const settleSpy = vi.spyOn(mockClient, "settle").mockResolvedValueOnce(
      buildSettleResponse({
        success: false,
        errorReason: "settlement_pending",
        transaction: "",
      }),
    );

    const server = new x402ResourceServer(mockClient);
    const result = await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  it("does not retry at all on immediate success", async () => {
    const mockClient = new MockFacilitatorClient(buildSupportedResponse());
    const settleSpy = vi
      .spyOn(mockClient, "settle")
      .mockResolvedValueOnce(buildSettleResponse({ success: true }));

    const server = new x402ResourceServer(mockClient);
    const result = await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it("caps retries at exactly one even when the retry is also settlement_pending", async () => {
    const mockClient = new MockFacilitatorClient(buildSupportedResponse());
    const pendingResponse = buildSettleResponse({
      success: false,
      errorReason: "settlement_pending",
      transaction: "0xstillpending",
    });
    const settleSpy = vi
      .spyOn(mockClient, "settle")
      .mockResolvedValueOnce(pendingResponse)
      .mockResolvedValueOnce(pendingResponse);

    const server = new x402ResourceServer(mockClient);
    const result = await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

    // Exactly one retry: no third attempt regardless of the second outcome.
    expect(settleSpy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settlement_pending");
    expect(result.transaction).toBe("0xstillpending");
  });

  it("retries with the exact same payload/requirements on both attempts (no mutation)", async () => {
    const mockClient = new MockFacilitatorClient(buildSupportedResponse());
    const settleSpy = vi
      .spyOn(mockClient, "settle")
      .mockResolvedValueOnce(
        buildSettleResponse({
          success: false,
          errorReason: "settlement_pending",
          transaction: "0xpendingtx",
        }),
      )
      .mockResolvedValueOnce(buildSettleResponse({ success: true }));

    const server = new x402ResourceServer(mockClient);
    const payload = buildPaymentPayload();
    const requirements = buildPaymentRequirements();

    await server.settlePayment(payload, requirements);

    expect(settleSpy.mock.calls).toHaveLength(2);
    expect(settleSpy.mock.calls[0][0]).toEqual(settleSpy.mock.calls[1][0]);
    expect(settleSpy.mock.calls[0][1]).toEqual(settleSpy.mock.calls[1][1]);
  });

  it("also retries via the fallback (no-specific-facilitator) settle path", async () => {
    const mockClient = new MockFacilitatorClient(buildSupportedResponse());
    const settleSpy = vi
      .spyOn(mockClient, "settle")
      .mockResolvedValueOnce(
        buildSettleResponse({
          success: false,
          errorReason: "settlement_pending",
          transaction: "0xpendingtx",
        }),
      )
      .mockResolvedValueOnce(buildSettleResponse({ success: true }));

    // No initialize()/register() call: settlePayment falls through the
    // "no specific facilitator found" loop, which iterates all registered
    // clients directly rather than using the version/network/scheme map.
    const server = new x402ResourceServer(mockClient);
    const result = await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

    expect(settleSpy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });
});

describe("x402ResourceServer settlePayment - success:false routes through onSettleFailure", () => {
  it("routes a returned success:false result through onSettleFailure and returns its recovered result", async () => {
    const mockClient = new MockFacilitatorClient(buildSupportedResponse());
    vi.spyOn(mockClient, "settle").mockResolvedValueOnce(
      buildSettleResponse({
        success: false,
        errorReason: "invalid_signature",
        transaction: "",
      }),
    );

    const server = new x402ResourceServer(mockClient);
    const recoveredResponse = buildSettleResponse({ success: true, transaction: "0xrecovered" });
    const hook = vi.fn().mockResolvedValue({ recovered: true, result: recoveredResponse });
    server.onSettleFailure(hook);

    const result = await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

    expect(hook).toHaveBeenCalledTimes(1);
    const failureContext = hook.mock.calls[0][0];
    expect(failureContext.error).toBeInstanceOf(Error);
    expect(failureContext.error.message).toContain("invalid_signature");
    expect(result).toEqual(recoveredResponse);
  });

  it("returns the success:false response as-is (does not throw) when no hook recovers it", async () => {
    const mockClient = new MockFacilitatorClient(buildSupportedResponse());
    vi.spyOn(mockClient, "settle").mockResolvedValueOnce(
      buildSettleResponse({
        success: false,
        errorReason: "invalid_signature",
        transaction: "",
      }),
    );

    const server = new x402ResourceServer(mockClient);
    const hook = vi.fn().mockResolvedValue(undefined);
    server.onSettleFailure(hook);

    const result = await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

    expect(hook).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_signature");
  });

  it("falls back to a generic 'Settlement failed' reason when errorReason is empty", async () => {
    const mockClient = new MockFacilitatorClient(buildSupportedResponse());
    vi.spyOn(mockClient, "settle").mockResolvedValueOnce(
      buildSettleResponse({ success: false, errorReason: undefined, transaction: "" }),
    );

    const server = new x402ResourceServer(mockClient);
    const hook = vi.fn().mockResolvedValue(undefined);
    server.onSettleFailure(hook);

    await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

    const failureContext = hook.mock.calls[0][0];
    expect(failureContext.error.message).toContain("Settlement failed");
  });

  it("does not run afterSettle hooks when the final result is success:false", async () => {
    const mockClient = new MockFacilitatorClient(buildSupportedResponse());
    vi.spyOn(mockClient, "settle").mockResolvedValueOnce(
      buildSettleResponse({ success: false, errorReason: "invalid_signature", transaction: "" }),
    );

    const server = new x402ResourceServer(mockClient);
    const afterSettle = vi.fn().mockResolvedValue(undefined);
    server.onAfterSettle(afterSettle);

    await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

    expect(afterSettle).not.toHaveBeenCalled();
  });

  it("still runs afterSettle (not onSettleFailure) when the result is success:true", async () => {
    const mockClient = new MockFacilitatorClient(buildSupportedResponse());
    vi.spyOn(mockClient, "settle").mockResolvedValueOnce(buildSettleResponse({ success: true }));

    const server = new x402ResourceServer(mockClient);
    const afterSettle = vi.fn().mockResolvedValue(undefined);
    const onSettleFailure = vi.fn().mockResolvedValue(undefined);
    server.onAfterSettle(afterSettle);
    server.onSettleFailure(onSettleFailure);

    const result = await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

    expect(result.success).toBe(true);
    expect(afterSettle).toHaveBeenCalledTimes(1);
    expect(onSettleFailure).not.toHaveBeenCalled();
  });

  it("routes a settlement_pending failure that survives the retry through onSettleFailure too", async () => {
    const mockClient = new MockFacilitatorClient(buildSupportedResponse());
    const pendingResponse = buildSettleResponse({
      success: false,
      errorReason: "settlement_pending",
      transaction: "0xstillpending",
    });
    vi.spyOn(mockClient, "settle")
      .mockResolvedValueOnce(pendingResponse)
      .mockResolvedValueOnce(pendingResponse);

    const server = new x402ResourceServer(mockClient);
    const hook = vi.fn().mockResolvedValue(undefined);
    server.onSettleFailure(hook);

    const result = await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

    expect(hook).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.transaction).toBe("0xstillpending");
  });
});
