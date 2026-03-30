import { afterEach, describe, expect, it, vi } from "vitest";
import { HTTPFacilitatorClient } from "../../../src/http/httpFacilitatorClient";
import { FacilitatorResponseError, SettleError, VerifyError } from "../../../src/types";
import { PaymentPayload, PaymentRequirements } from "../../../src/types/payments";

const paymentRequirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x0000000000000000000000000000000000000000",
  amount: "1000000",
  payTo: "0x1234567890123456789012345678901234567890",
  maxTimeoutSeconds: 300,
  extra: {},
};

const paymentPayload: PaymentPayload = {
  x402Version: 2,
  accepted: paymentRequirements,
  payload: { signature: "0xmock" },
};

describe("HTTPFacilitatorClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("throws FacilitatorResponseError for invalid verify JSON on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));

    const client = new HTTPFacilitatorClient({ url: "https://facilitator.test" });
    const error = await client
      .verify(paymentPayload, paymentRequirements)
      .catch(caught => caught as Error);

    expect(error).toBeInstanceOf(FacilitatorResponseError);
    expect(error.message).toContain("Facilitator verify returned invalid JSON");
  });

  it("throws FacilitatorResponseError for invalid settle data on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })),
    );

    const client = new HTTPFacilitatorClient({ url: "https://facilitator.test" });
    const error = await client
      .settle(paymentPayload, paymentRequirements)
      .catch(caught => caught as Error);

    expect(error).toBeInstanceOf(FacilitatorResponseError);
    expect(error.message).toContain("Facilitator settle returned invalid data");
  });

  it("throws FacilitatorResponseError for invalid supported data on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ kinds: [{ scheme: "exact" }] }), { status: 200 }),
        ),
    );

    const client = new HTTPFacilitatorClient({ url: "https://facilitator.test" });
    const error = await client.getSupported().catch(caught => caught as Error);

    expect(error).toBeInstanceOf(FacilitatorResponseError);
    expect(error.message).toContain("Facilitator supported returned invalid data");
  });

  it("preserves VerifyError semantics for valid non-200 verify responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            isValid: false,
            invalidReason: "invalid_signature",
            invalidMessage: "signature mismatch",
          }),
          { status: 400 },
        ),
      ),
    );

    const client = new HTTPFacilitatorClient({ url: "https://facilitator.test" });

    await expect(client.verify(paymentPayload, paymentRequirements)).rejects.toThrow(VerifyError);
  });

  it("preserves SettleError semantics for valid non-200 settle responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            errorReason: "insufficient_allowance",
            transaction: "",
            network: "eip155:8453",
          }),
          { status: 400 },
        ),
      ),
    );

    const client = new HTTPFacilitatorClient({ url: "https://facilitator.test" });

    await expect(client.settle(paymentPayload, paymentRequirements)).rejects.toThrow(SettleError);
  });

  it("parses verify 200 when optional string fields are JSON null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            isValid: true,
            invalidReason: null,
            invalidMessage: null,
            payer: null,
          }),
          { status: 200 },
        ),
      ),
    );

    const client = new HTTPFacilitatorClient({ url: "https://facilitator.test" });
    const result = await client.verify(paymentPayload, paymentRequirements);

    expect(result.isValid).toBe(true);
    expect(result.invalidReason).toBeUndefined();
    expect(result.invalidMessage).toBeUndefined();
    expect(result.payer).toBeUndefined();
  });

  it("parses settle 200 when optional string fields are JSON null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            transaction: "0xabc",
            network: "eip155:8453",
            errorReason: null,
            errorMessage: null,
            payer: null,
          }),
          { status: 200 },
        ),
      ),
    );

    const client = new HTTPFacilitatorClient({ url: "https://facilitator.test" });
    const result = await client.settle(paymentPayload, paymentRequirements);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0xabc");
    expect(result.network).toBe("eip155:8453");
    expect(result.errorReason).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
    expect(result.payer).toBeUndefined();
  });

  describe("URL normalization", () => {
    it("strips trailing slashes from the configured URL", () => {
      const client = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator/" });
      expect(client.url).toBe("https://x402.org/facilitator");
    });

    it("strips multiple trailing slashes", () => {
      const client = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator///" });
      expect(client.url).toBe("https://x402.org/facilitator");
    });

    it("leaves URLs without trailing slash unchanged", () => {
      const client = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
      expect(client.url).toBe("https://x402.org/facilitator");
    });

    it("uses default URL when no config is provided", () => {
      const client = new HTTPFacilitatorClient();
      expect(client.url).toBe("https://x402.org/facilitator");
    });
  });

  describe("redirect handling", () => {
    it("passes redirect: follow to fetch on getSupported", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
          }),
          { status: 200 },
        ),
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = new HTTPFacilitatorClient({ url: "https://facilitator.test" });
      await client.getSupported();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://facilitator.test/supported",
        expect.objectContaining({ redirect: "follow" }),
      );
    });

    it("passes redirect: follow to fetch on verify", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ isValid: true }), { status: 200 }));
      vi.stubGlobal("fetch", mockFetch);

      const client = new HTTPFacilitatorClient({ url: "https://facilitator.test" });
      await client.verify(paymentPayload, paymentRequirements);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://facilitator.test/verify",
        expect.objectContaining({ redirect: "follow" }),
      );
    });

    it("passes redirect: follow to fetch on settle", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            transaction: "0xabc",
            network: "eip155:8453",
          }),
          { status: 200 },
        ),
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = new HTTPFacilitatorClient({ url: "https://facilitator.test" });
      await client.settle(paymentPayload, paymentRequirements);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://facilitator.test/settle",
        expect.objectContaining({ redirect: "follow" }),
      );
    });

    it("constructs correct endpoint URLs after trailing slash normalization", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
          }),
          { status: 200 },
        ),
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator/" });
      await client.getSupported();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://x402.org/facilitator/supported",
        expect.anything(),
      );
    });
  });
});
