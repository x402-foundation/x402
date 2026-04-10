import { OpenPaymentsClientError } from "@interledger/open-payments";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  discoverWalletAddress,
  generatePaymentUrlCacheKey,
  getAssetScaleFromExtra,
  normalizeUrl,
  retryWithBackoff,
  RetryConditionNotMetError,
  waitForCondition,
  wrapError,
} from "../../src/utils";

global.fetch = vi.fn();

const mockWalletResponse = {
  resourceServer: "https://resource.example.com",
  authServer: "https://auth.example.com",
  assetCode: "USD",
  assetScale: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("discoverWalletAddress", () => {
  it("should return wallet info on success", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockWalletResponse,
    });

    const result = await discoverWalletAddress("https://wallet.example.com/alice");
    expect(result.resourceServer).toBe("https://resource.example.com");
    expect(result.authServer).toBe("https://auth.example.com");
    expect(result.assetCode).toBe("USD");
    expect(result.assetScale).toBe(2);
  });

  it("should throw when response is not ok", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await expect(discoverWalletAddress("https://wallet.example.com/alice")).rejects.toThrow(
      "Failed to fetch wallet address: 404 Not Found",
    );
  });

  it("should throw when resourceServer is missing", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ authServer: "https://auth.example.com" }),
    });

    await expect(discoverWalletAddress("https://wallet.example.com/alice")).rejects.toThrow(
      "Wallet address response at https://wallet.example.com/alice missing resourceServer or authServer",
    );
  });

  it("should throw when authServer is missing", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ resourceServer: "https://resource.example.com" }),
    });

    await expect(discoverWalletAddress("https://wallet.example.com/alice")).rejects.toThrow(
      "Wallet address response at https://wallet.example.com/alice missing resourceServer or authServer",
    );
  });

  it("should not rewrite protocols from the wallet address response", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        resourceServer: "https://resource.example.com",
        authServer: "https://auth.example.com",
      }),
    });

    const result = await discoverWalletAddress("http://wallet.example.com/alice");
    expect(result.resourceServer).toBe("https://resource.example.com");
    expect(result.authServer).toBe("https://auth.example.com");
  });
});

describe("retryWithBackoff", () => {
  it("should return the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, 3, 0);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry on failure and eventually succeed", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValueOnce("success");

    const result = await retryWithBackoff(fn, 3, 0);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should throw after exhausting retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(retryWithBackoff(fn, 2, 0)).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("should retry when shouldRetry predicate returns true", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce("pending")
      .mockResolvedValueOnce("pending")
      .mockResolvedValueOnce("done");

    const result = await retryWithBackoff(fn, 3, 0, r => r !== "done");
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should throw when shouldRetry condition never met within retries", async () => {
    const fn = vi.fn().mockResolvedValue("pending");
    await expect(retryWithBackoff(fn, 2, 0, r => r !== "done")).rejects.toThrow(
      RetryConditionNotMetError,
    );
  });
});

describe("getAssetScaleFromExtra", () => {
  it("returns undefined when extra is undefined or missing assetScale", () => {
    expect(getAssetScaleFromExtra(undefined)).toBeUndefined();
    expect(getAssetScaleFromExtra({})).toBeUndefined();
  });

  it("returns the number when assetScale is a finite number", () => {
    expect(getAssetScaleFromExtra({ assetScale: 2 })).toBe(2);
  });

  it("returns undefined for non-numbers", () => {
    expect(getAssetScaleFromExtra({ assetScale: "2" })).toBeUndefined();
    expect(getAssetScaleFromExtra({ assetScale: NaN })).toBeUndefined();
  });
});

describe("waitForCondition", () => {
  it("should resolve immediately when condition is met", async () => {
    const checkFn = vi.fn().mockResolvedValue("ready");
    const result = await waitForCondition(checkFn, 1000, 10);
    expect(result).toBe("ready");
    expect(checkFn).toHaveBeenCalledTimes(1);
  });

  it("should throw when condition is never met within timeout", async () => {
    const checkFn = vi.fn().mockResolvedValue(null);
    await expect(waitForCondition(checkFn, 50, 10)).rejects.toThrow(
      "Condition not met within 50ms",
    );
  });
});

describe("normalizeUrl", () => {
  it("should remove trailing slashes", () => {
    expect(normalizeUrl("https://example.com/path/")).toBe("https://example.com/path");
  });

  it("should remove query string", () => {
    expect(normalizeUrl("https://example.com/path?foo=bar")).toBe("https://example.com/path");
  });

  it("should remove hash", () => {
    expect(normalizeUrl("https://example.com/path#section")).toBe("https://example.com/path");
  });

  it("should handle URLs without trailing slash", () => {
    expect(normalizeUrl("https://example.com/path")).toBe("https://example.com/path");
  });

  it("should handle invalid URLs gracefully", () => {
    expect(normalizeUrl("not-a-url/")).toBe("not-a-url");
  });
});

describe("generatePaymentUrlCacheKey", () => {
  it("should combine incoming payment URL and resource URL", () => {
    const key = generatePaymentUrlCacheKey(
      "https://wallet.example.com/incoming/123",
      "https://api.example.com/resource",
    );
    expect(key).toBe("https://wallet.example.com/incoming/123:https://api.example.com/resource");
  });

  it("should normalize the resource URL", () => {
    const key1 = generatePaymentUrlCacheKey(
      "https://wallet.example.com/incoming/123",
      "https://api.example.com/resource/",
    );
    const key2 = generatePaymentUrlCacheKey(
      "https://wallet.example.com/incoming/123",
      "https://api.example.com/resource",
    );
    expect(key1).toBe(key2);
  });
});

describe("wrapError", () => {
  it("should rethrow with context prefix and Error message", () => {
    const handler = wrapError("Failed to call API at https://example.com");
    expect(() => handler(new Error("connection refused"))).toThrow(
      "Failed to call API at https://example.com: connection refused",
    );
  });

  it("should prefer description over message for Open Payments SDK errors", () => {
    const handler = wrapError("Failed to request grant");
    const opError = new OpenPaymentsClientError("generic", { description: "Token expired" });
    expect(() => handler(opError)).toThrow("Failed to request grant: Token expired");
  });

  it("should stringify non-Error values", () => {
    const handler = wrapError("Failed to fetch");
    expect(() => handler("timeout")).toThrow("Failed to fetch: timeout");
  });
});
