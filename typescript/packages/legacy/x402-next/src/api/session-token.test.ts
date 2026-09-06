import { NextRequest } from "next/server";
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
  let mockRequest: NextRequest;
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

    // Set up NextRequest mock
    mockRequest = {
      json: vi.fn(),
    } as unknown as NextRequest;
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

      vi.mocked(mockRequest.json).mockResolvedValue(mockRequestBody);
      vi.mocked(generateJwt).mockResolvedValue(mockJwt);
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSessionToken),
      } as unknown as globalThis.Response);

      const response = await POST(mockRequest);
      const responseData = await response.json();

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

      expect(response.status).toBe(200);
      expect(responseData).toEqual(mockSessionToken);
    });
  });

  describe("environment variable validation", () => {
    it("should return 500 when CDP_API_KEY_ID is missing", async () => {
      mockEnv.CDP_API_KEY_ID = undefined;

      const response = await POST(mockRequest);
      const responseData = await response.json();

      expect(response.status).toBe(500);
      expect(responseData).toEqual({
        error: "Server configuration error: Missing CDP API credentials",
      });
    });

    it("should return 500 when CDP_API_KEY_SECRET is missing", async () => {
      mockEnv.CDP_API_KEY_SECRET = undefined;

      const response = await POST(mockRequest);
      const responseData = await response.json();

      expect(response.status).toBe(500);
      expect(responseData).toEqual({
        error: "Server configuration error: Missing CDP API credentials",
      });
    });

    it("should return 500 when both API keys are missing", async () => {
      mockEnv.CDP_API_KEY_ID = undefined;
      mockEnv.CDP_API_KEY_SECRET = undefined;

      const response = await POST(mockRequest);
      const responseData = await response.json();

      expect(response.status).toBe(500);
      expect(responseData).toEqual({
        error: "Server configuration error: Missing CDP API credentials",
      });
    });
  });

  describe("request body validation", () => {
    it("should return 400 when addresses is missing", async () => {
      vi.mocked(mockRequest.json).mockResolvedValue({});

      const response = await POST(mockRequest);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData).toEqual({
        error: "addresses is required and must be a non-empty array",
      });
    });

    it("should return 400 when addresses is null", async () => {
      vi.mocked(mockRequest.json).mockResolvedValue({ addresses: null });

      const response = await POST(mockRequest);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData).toEqual({
        error: "addresses is required and must be a non-empty array",
      });
    });

    it("should return 400 when addresses is not an array", async () => {
      vi.mocked(mockRequest.json).mockResolvedValue({ addresses: "not-an-array" });

      const response = await POST(mockRequest);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData).toEqual({
        error: "addresses is required and must be a non-empty array",
      });
    });

    it("should return 400 when addresses is empty array", async () => {
      vi.mocked(mockRequest.json).mockResolvedValue({ addresses: [] });

      const response = await POST(mockRequest);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData).toEqual({
        error: "addresses is required and must be a non-empty array",
      });
    });
  });

  describe("JWT generation errors", () => {
    it("should return 500 when JWT generation fails", async () => {
      const mockRequestBody = {
        addresses: [{ address: "0x1234567890123456789012345678901234567890" }],
      };

      vi.mocked(mockRequest.json).mockResolvedValue(mockRequestBody);
      vi.mocked(generateJwt).mockRejectedValue(new Error("JWT generation failed"));

      const response = await POST(mockRequest);
      const responseData = await response.json();

      expect(response.status).toBe(500);
      expect(responseData).toEqual({
        error: "Internal server error",
      });
    });
  });

  describe("CDP API errors", () => {
    it("should return 400 when CDP API returns 400", async () => {
      const mockRequestBody = {
        addresses: [{ address: "0x1234567890123456789012345678901234567890" }],
      };

      vi.mocked(mockRequest.json).mockResolvedValue(mockRequestBody);
      vi.mocked(generateJwt).mockResolvedValue("mock-jwt");
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad Request"),
      } as unknown as globalThis.Response);

      const response = await POST(mockRequest);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData).toEqual({
        error: "Failed to generate session token",
      });
    });

    it("should return 401 when CDP API returns 401", async () => {
      const mockRequestBody = {
        addresses: [{ address: "0x1234567890123456789012345678901234567890" }],
      };

      vi.mocked(mockRequest.json).mockResolvedValue(mockRequestBody);
      vi.mocked(generateJwt).mockResolvedValue("mock-jwt");
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      } as unknown as globalThis.Response);

      const response = await POST(mockRequest);
      const responseData = await response.json();

      expect(response.status).toBe(401);
      expect(responseData).toEqual({
        error: "Failed to generate session token",
      });
    });

    it("should return 500 when CDP API returns 500", async () => {
      const mockRequestBody = {
        addresses: [{ address: "0x1234567890123456789012345678901234567890" }],
      };

      vi.mocked(mockRequest.json).mockResolvedValue(mockRequestBody);
      vi.mocked(generateJwt).mockResolvedValue("mock-jwt");
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      } as unknown as globalThis.Response);

      const response = await POST(mockRequest);
      const responseData = await response.json();

      expect(response.status).toBe(500);
      expect(responseData).toEqual({
        error: "Failed to generate session token",
      });
    });
  });

  describe("network errors", () => {
    it("should return 500 when fetch fails", async () => {
      const mockRequestBody = {
        addresses: [{ address: "0x1234567890123456789012345678901234567890" }],
      };

      vi.mocked(mockRequest.json).mockResolvedValue(mockRequestBody);
      vi.mocked(generateJwt).mockResolvedValue("mock-jwt");
      vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

      const response = await POST(mockRequest);
      const responseData = await response.json();

      expect(response.status).toBe(500);
      expect(responseData).toEqual({
        error: "Internal server error",
      });
    });

    it("should return 500 when response.json() fails", async () => {
      const mockRequestBody = {
        addresses: [{ address: "0x1234567890123456789012345678901234567890" }],
      };

      vi.mocked(mockRequest.json).mockResolvedValue(mockRequestBody);
      vi.mocked(generateJwt).mockResolvedValue("mock-jwt");
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error("JSON parsing error")),
      } as unknown as globalThis.Response);

      const response = await POST(mockRequest);
      const responseData = await response.json();

      expect(response.status).toBe(500);
      expect(responseData).toEqual({
        error: "Internal server error",
      });
    });

    it("should return 500 when request body parsing fails", async () => {
      vi.mocked(mockRequest.json).mockRejectedValue(new Error("JSON parsing error"));

      const response = await POST(mockRequest);
      const responseData = await response.json();

      expect(response.status).toBe(500);
      expect(responseData).toEqual({
        error: "Internal server error",
      });
    });
  });
});
