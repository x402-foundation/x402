import { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { POST } from "./session-token";

// Mock the CDP SDK
vi.mock("@coinbase/cdp-sdk/auth", () => ({
  generateJwt: vi.fn(),
}));

// Mock fetch globally
global.fetch = vi.fn();

describe("session-token POST handler", () => {
  let mockContext: Context;
  let mockEnv: Record<string, string | undefined>;

  beforeEach(() => {
    vi.resetAllMocks();

    // Mock environment variables
    mockEnv = {
      CDP_API_KEY_ID: "test-key-id",
      CDP_API_KEY_SECRET: "test-key-secret",
    };
    vi.stubGlobal("process", {
      env: mockEnv,
    });

    // Set up Hono context mock
    mockContext = {
      req: {
        json: vi.fn(),
      },
      json: vi.fn(),
    } as unknown as Context;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("successful token generation", () => {
    it("should generate session token successfully", async () => {
      const mockJwt = "mock-jwt-token";
      const mockSessionToken = {
        token: "session-token-123",
        expires_at: "2024-01-01T00:00:00Z",
      };

      const mockRequestBody = {
        addresses: [{ address: "0x1234567890123456789012345678901234567890" }],
      };

      vi.mocked(mockContext.req.json).mockResolvedValue(mockRequestBody);
      vi.mocked(generateJwt).mockResolvedValue(mockJwt);
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSessionToken),
      } as unknown as globalThis.Response);

      await POST(mockContext);

      expect(generateJwt).toHaveBeenCalledWith({
        apiKeyId: "test-key-id",
        apiKeySecret: "test-key-secret",
        requestMethod: "POST",
        requestHost: "api.developer.coinbase.com",
        requestPath: "/onramp/v1/token",
      });

      expect(fetch).toHaveBeenCalledWith("https://api.developer.coinbase.com/onramp/v1/token", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mockJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          addresses: [
            {
              address: "0x1234567890123456789012345678901234567890",
              blockchains: ["base"],
            },
          ],
        }),
      });

      expect(mockContext.json).toHaveBeenCalledWith(mockSessionToken);
    });
  });

  describe("environment variable validation", () => {
    it("should return 500 when CDP_API_KEY_ID is missing", async () => {
      mockEnv.CDP_API_KEY_ID = undefined;

      await POST(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        { error: "Server configuration error: Missing CDP API credentials" },
        { status: 500 },
      );
    });

    it("should return 500 when CDP_API_KEY_SECRET is missing", async () => {
      mockEnv.CDP_API_KEY_SECRET = undefined;

      await POST(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        { error: "Server configuration error: Missing CDP API credentials" },
        { status: 500 },
      );
    });

    it("should return 500 when both API keys are missing", async () => {
      mockEnv.CDP_API_KEY_ID = undefined;
      mockEnv.CDP_API_KEY_SECRET = undefined;

      await POST(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        { error: "Server configuration error: Missing CDP API credentials" },
        { status: 500 },
      );
    });
  });

  describe("request body validation", () => {
    it("should return 400 when addresses is missing", async () => {
      vi.mocked(mockContext.req.json).mockResolvedValue({});

      await POST(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        { error: "addresses is required and must be a non-empty array" },
        { status: 400 },
      );
    });

    it("should return 400 when addresses is null", async () => {
      vi.mocked(mockContext.req.json).mockResolvedValue({ addresses: null });

      await POST(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        { error: "addresses is required and must be a non-empty array" },
        { status: 400 },
      );
    });

    it("should return 400 when addresses is not an array", async () => {
      vi.mocked(mockContext.req.json).mockResolvedValue({ addresses: "not-an-array" });

      await POST(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        { error: "addresses is required and must be a non-empty array" },
        { status: 400 },
      );
    });

    it("should return 400 when addresses is empty array", async () => {
      vi.mocked(mockContext.req.json).mockResolvedValue({ addresses: [] });

      await POST(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        { error: "addresses is required and must be a non-empty array" },
        { status: 400 },
      );
    });
  });

  describe("JWT generation errors", () => {
    it("should return 500 when JWT generation fails", async () => {
      const mockRequestBody = {
        addresses: [{ address: "0x1234567890123456789012345678901234567890" }],
      };

      vi.mocked(mockContext.req.json).mockResolvedValue(mockRequestBody);
      vi.mocked(generateJwt).mockRejectedValue(new Error("JWT generation failed"));

      await POST(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        { error: "Internal server error" },
        { status: 500 },
      );
    });
  });

  describe("CDP API errors", () => {
    it("should return 400 when CDP API returns 400", async () => {
      const mockRequestBody = {
        addresses: [{ address: "0x1234567890123456789012345678901234567890" }],
      };

      vi.mocked(mockContext.req.json).mockResolvedValue(mockRequestBody);
      vi.mocked(generateJwt).mockResolvedValue("mock-jwt");
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad Request"),
      } as unknown as globalThis.Response);

      await POST(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        { error: "Failed to generate session token" },
        { status: 400 },
      );
    });

    it("should return 401 when CDP API returns 401", async () => {
      const mockRequestBody = {
        addresses: [{ address: "0x1234567890123456789012345678901234567890" }],
      };

      vi.mocked(mockContext.req.json).mockResolvedValue(mockRequestBody);
      vi.mocked(generateJwt).mockResolvedValue("mock-jwt");
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      } as unknown as globalThis.Response);

      await POST(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        { error: "Failed to generate session token" },
        { status: 401 },
      );
    });

    it("should return 500 when CDP API returns 500", async () => {
      const mockRequestBody = {
        addresses: [{ address: "0x1234567890123456789012345678901234567890" }],
      };

      vi.mocked(mockContext.req.json).mockResolvedValue(mockRequestBody);
      vi.mocked(generateJwt).mockResolvedValue("mock-jwt");
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      } as unknown as globalThis.Response);

      await POST(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        { error: "Failed to generate session token" },
        { status: 500 },
      );
    });
  });

  describe("network errors", () => {
    it("should return 500 when fetch fails", async () => {
      const mockRequestBody = {
        addresses: [{ address: "0x1234567890123456789012345678901234567890" }],
      };

      vi.mocked(mockContext.req.json).mockResolvedValue(mockRequestBody);
      vi.mocked(generateJwt).mockResolvedValue("mock-jwt");
      vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

      await POST(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        { error: "Internal server error" },
        { status: 500 },
      );
    });

    it("should return 500 when response.json() fails", async () => {
      const mockRequestBody = {
        addresses: [{ address: "0x1234567890123456789012345678901234567890" }],
      };

      vi.mocked(mockContext.req.json).mockResolvedValue(mockRequestBody);
      vi.mocked(generateJwt).mockResolvedValue("mock-jwt");
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error("JSON parsing error")),
      } as unknown as globalThis.Response);

      await POST(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        { error: "Internal server error" },
        { status: 500 },
      );
    });

    it("should return 500 when request body parsing fails", async () => {
      vi.mocked(mockContext.req.json).mockRejectedValue(new Error("JSON parsing error"));

      await POST(mockContext);

      expect(mockContext.json).toHaveBeenCalledWith(
        { error: "Internal server error" },
        { status: 500 },
      );
    });
  });
});
