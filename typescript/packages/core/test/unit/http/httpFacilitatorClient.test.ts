import { afterEach, describe, expect, it, vi } from "vitest";
import { HTTPFacilitatorClient, computeRetryDelay } from "../../../src/http/httpFacilitatorClient";
import {
  FacilitatorResponseError,
  FacilitatorTimeoutError,
  SettleError,
  VerifyError,
  getFacilitatorResponseError,
} from "../../../src/types";
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
    vi.useRealTimers();
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

  describe("createAuthHeaders", () => {
    it("returns the path-scoped headers for a correctly keyed callback", async () => {
      const client = new HTTPFacilitatorClient({
        url: "https://facilitator.test",
        createAuthHeaders: async () => ({
          verify: { Authorization: "Bearer verify" },
          settle: { Authorization: "Bearer settle" },
          supported: { Authorization: "Bearer supported" },
        }),
      });

      expect(await client.createAuthHeaders("verify")).toEqual({
        headers: { Authorization: "Bearer verify" },
      });
      expect(await client.createAuthHeaders("settle")).toEqual({
        headers: { Authorization: "Bearer settle" },
      });
    });

    it("returns empty headers for a path the callback intentionally omits", async () => {
      const client = new HTTPFacilitatorClient({
        url: "https://facilitator.test",
        createAuthHeaders: async () => ({ verify: { Authorization: "Bearer verify" } }),
      });

      expect(await client.createAuthHeaders("settle")).toEqual({ headers: {} });
    });

    it("returns empty headers when the callback returns an empty object", async () => {
      const client = new HTTPFacilitatorClient({
        url: "https://facilitator.test",
        createAuthHeaders: async () => ({}),
      });

      expect(await client.createAuthHeaders("verify")).toEqual({ headers: {} });
    });

    it("throws when the callback returns a flat headers object", async () => {
      const client = new HTTPFacilitatorClient({
        url: "https://facilitator.test",
        // Intentionally wrong shape: a flat headers object instead of one keyed by path.
        createAuthHeaders: async () => ({ Authorization: "Bearer token" }) as never,
      });

      const error = await client.createAuthHeaders("verify").catch(caught => caught as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("must return an object keyed by facilitator path");
    });

    it("throws when a flat object has non-string header values", async () => {
      const client = new HTTPFacilitatorClient({
        url: "https://facilitator.test",
        createAuthHeaders: async () => ({ Authorization: 123 }) as never,
      });

      const error = await client.createAuthHeaders("verify").catch(caught => caught as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("must return an object keyed by facilitator path");
    });

    it("returns empty headers when no callback is configured", async () => {
      const client = new HTTPFacilitatorClient({ url: "https://facilitator.test" });
      expect(await client.createAuthHeaders("verify")).toEqual({ headers: {} });
    });

    it("sends the path-scoped auth headers on the outgoing verify request", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ isValid: true, payer: paymentRequirements.payTo }), {
          status: 200,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = new HTTPFacilitatorClient({
        url: "https://facilitator.test",
        createAuthHeaders: async () => ({
          verify: { Authorization: "Bearer verify" },
          settle: { Authorization: "Bearer settle" },
          supported: { Authorization: "Bearer supported" },
        }),
      });

      await client.verify(paymentPayload, paymentRequirements).catch(() => undefined);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://facilitator.test/verify",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer verify" }),
        }),
      );
    });
  });
});

describe("request timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("defaults timeoutMs to 30 seconds", () => {
    expect(new HTTPFacilitatorClient().timeoutMs).toBe(30_000);
    expect(new HTTPFacilitatorClient({ timeoutMs: 5_000 }).timeoutMs).toBe(5_000);
  });

  it("rejects a timeoutMs that AbortSignal.timeout cannot honor", () => {
    // Non-integers throw ERR_OUT_OF_RANGE at request time, and values above
    // 2^31 - 1 overflow Node's 32-bit timers into an effective ~1ms deadline.
    for (const timeoutMs of [0, -5, NaN, Infinity, 0.5, 2_147_483_648]) {
      expect(() => new HTTPFacilitatorClient({ timeoutMs })).toThrow(RangeError);
    }
  });

  it("accepts the maximum timer-safe timeoutMs", () => {
    expect(new HTTPFacilitatorClient({ timeoutMs: 2_147_483_647 }).timeoutMs).toBe(2_147_483_647);
  });

  it("passes an AbortSignal to fetch on verify, settle, and getSupported", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ isValid: true, payer: paymentRequirements.payTo }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            transaction: "0xtransaction",
            network: paymentRequirements.network,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kinds: [{ x402Version: 2, scheme: "exact", network: paymentRequirements.network }],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new HTTPFacilitatorClient({ url: "https://facilitator.test" });
    await client.verify(paymentPayload, paymentRequirements);
    await client.settle(paymentPayload, paymentRequirements);
    await client.getSupported();

    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    }
  });

  it("throws FacilitatorTimeoutError when verify never receives response headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      ),
    );

    const client = new HTTPFacilitatorClient({
      url: "https://facilitator.test",
      timeoutMs: 25,
    });
    const error = await client
      .verify(paymentPayload, paymentRequirements)
      .catch(caught => caught as FacilitatorTimeoutError);

    expect(error).toBeInstanceOf(FacilitatorTimeoutError);
    expect(error).toBeInstanceOf(FacilitatorResponseError);
    expect(error.message).toContain("verify request timed out after 25ms");
    expect(error.operation).toBe("verify");
    expect(error.timeoutMs).toBe(25);
  });

  it("throws FacilitatorTimeoutError when the settle response body stalls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const signal = init.signal!;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason));
            }),
        } as unknown as Response);
      }),
    );

    const client = new HTTPFacilitatorClient({
      url: "https://facilitator.test",
      timeoutMs: 25,
    });
    const error = await client
      .settle(paymentPayload, paymentRequirements)
      .catch(caught => caught as FacilitatorTimeoutError);

    expect(error).toBeInstanceOf(FacilitatorTimeoutError);
    expect(error.operation).toBe("settle");
  });

  it("throws FacilitatorTimeoutError when getSupported stalls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      ),
    );

    const client = new HTTPFacilitatorClient({
      url: "https://facilitator.test",
      timeoutMs: 25,
    });
    const error = await client.getSupported().catch(caught => caught as FacilitatorTimeoutError);

    expect(error).toBeInstanceOf(FacilitatorTimeoutError);
    expect(error.operation).toBe("supported");
    expect(error.message).toContain("supported request timed out");
  });

  it("throws FacilitatorTimeoutError when a 429 error body stalls, without retrying", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal!;
      return Promise.resolve({
        ok: false,
        status: 429,
        headers: new Headers(),
        text: () =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
          }),
      } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HTTPFacilitatorClient({
      url: "https://facilitator.test",
      timeoutMs: 25,
    });
    const error = await client.getSupported().catch(caught => caught as FacilitatorTimeoutError);

    expect(error).toBeInstanceOf(FacilitatorTimeoutError);
    expect(error.operation).toBe("supported");
    // The deadline abort must not be masked as a retryable HTTP error.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not convert non-timeout failures into FacilitatorTimeoutError", async () => {
    const fetchError = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchError));

    const client = new HTTPFacilitatorClient({ url: "https://facilitator.test" });
    const error = await client
      .verify(paymentPayload, paymentRequirements)
      .catch(caught => caught as Error);

    expect(error).toBe(fetchError);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(FacilitatorTimeoutError);
  });

  it("applies a fresh deadline to each getSupported retry attempt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const signals: AbortSignal[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        signals.push(init.signal!);
        return Promise.resolve(new Response("rate limited", { status: 429 }));
      })
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            signals.push(init.signal!);
            init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new HTTPFacilitatorClient({
      url: "https://facilitator.test",
      timeoutMs: 50,
    });
    const resultPromise = client.getSupported();
    const guarded = resultPromise.catch((caught: unknown) => caught as Error);
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    const error = await guarded;

    expect(error).toBeInstanceOf(FacilitatorTimeoutError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("is found by getFacilitatorResponseError", () => {
    const timeoutError = new FacilitatorTimeoutError("supported", 30_000);

    expect(getFacilitatorResponseError(timeoutError)).toBe(timeoutError);
    expect(
      getFacilitatorResponseError(new Error("initialization failed", { cause: timeoutError })),
    ).toBe(timeoutError);
  });
});

describe("computeRetryDelay", () => {
  it("uses Retry-After delta-seconds when present", () => {
    expect(computeRetryDelay("5", 0)).toBe(5000);
    expect(computeRetryDelay("12", 1)).toBe(12_000);
  });

  it("uses Retry-After HTTP-date when present", () => {
    const future = new Date(Date.now() + 7000).toUTCString();
    const delay = computeRetryDelay(future, 0);
    // Allow a small window for elapsed time during the call.
    expect(delay).toBeGreaterThan(5000);
    expect(delay).toBeLessThanOrEqual(7000);
  });

  it("falls back to exponential backoff when Retry-After is missing", () => {
    expect(computeRetryDelay(null, 0)).toBe(1000);
    expect(computeRetryDelay(null, 1)).toBe(2000);
    expect(computeRetryDelay(null, 2)).toBe(4000);
  });

  it("falls back to exponential backoff when Retry-After is zero or negative", () => {
    expect(computeRetryDelay("0", 0)).toBe(1000);
    expect(computeRetryDelay("-5", 1)).toBe(2000);
  });

  it("falls back to exponential backoff when Retry-After is unparseable", () => {
    expect(computeRetryDelay("not-a-date", 1)).toBe(2000);
  });

  it("does not treat fractional Retry-After values as delta-seconds", () => {
    expect(computeRetryDelay("1.5", 1)).toBe(2000);
  });

  it("caps the delay to MAX_RETRY_DELAY_MS to prevent pathological waits", () => {
    expect(computeRetryDelay("9999", 0)).toBe(30_000);
  });
});
