import { describe, expect, it } from "vitest";
import {
  computeRoutePatterns,
  findMatchingRoute,
  getDefaultAsset,
  processPriceToAtomicAmount,
} from "./middleware";
import type { RoutesConfig, Network } from "../types";

describe("computeRoutePatterns", () => {
  it("should handle simple string price routes", () => {
    const routes: RoutesConfig = {
      "/api/test": "$0.01",
      "/api/other": "$0.02",
    };

    const patterns = computeRoutePatterns(routes);

    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toEqual({
      verb: "*",
      pattern: /^\/api\/test$/i,
      config: {
        price: "$0.01",
        network: "base-sepolia",
      },
    });
    expect(patterns[1]).toEqual({
      verb: "*",
      pattern: /^\/api\/other$/i,
      config: {
        price: "$0.02",
        network: "base-sepolia",
      },
    });
  });

  it("should handle routes with HTTP verbs", () => {
    const routes: RoutesConfig = {
      "GET /api/test": "$0.01",
      "POST /api/other": "$0.02",
    };

    const patterns = computeRoutePatterns(routes);

    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toEqual({
      verb: "GET",
      pattern: /^\/api\/test$/i,
      config: {
        price: "$0.01",
        network: "base-sepolia",
      },
    });
    expect(patterns[1]).toEqual({
      verb: "POST",
      pattern: /^\/api\/other$/i,
      config: {
        price: "$0.02",
        network: "base-sepolia",
      },
    });
  });

  it("should handle wildcard routes", () => {
    const routes: RoutesConfig = {
      "/api/*": "$0.01",
      "GET /api/users/*": "$0.02",
    };

    const patterns = computeRoutePatterns(routes);

    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toEqual({
      verb: "*",
      pattern: /^\/api\/.*?$/i,
      config: {
        price: "$0.01",
        network: "base-sepolia",
      },
    });
    expect(patterns[1]).toEqual({
      verb: "GET",
      pattern: /^\/api\/users\/.*?$/i,
      config: {
        price: "$0.02",
        network: "base-sepolia",
      },
    });
  });

  it("should handle route parameters", () => {
    const routes: RoutesConfig = {
      "/api/users/[id]": "$0.01",
      "GET /api/posts/[slug]": "$0.02",
    };

    const patterns = computeRoutePatterns(routes);

    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toEqual({
      verb: "*",
      pattern: /^\/api\/users\/[^\/]+$/i,
      config: {
        price: "$0.01",
        network: "base-sepolia",
      },
    });
    expect(patterns[1]).toEqual({
      verb: "GET",
      pattern: /^\/api\/posts\/[^\/]+$/i,
      config: {
        price: "$0.02",
        network: "base-sepolia",
      },
    });
  });

  it("should handle full route config objects", () => {
    const routes: RoutesConfig = {
      "/api/test": {
        price: "$0.01",
        network: "base-sepolia",
        config: {
          description: "Test route",
          mimeType: "application/json",
        },
      },
    };

    const patterns = computeRoutePatterns(routes);

    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toEqual({
      verb: "*",
      pattern: /^\/api\/test$/i,
      config: {
        price: "$0.01",
        network: "base-sepolia",
        config: {
          description: "Test route",
          mimeType: "application/json",
        },
      },
    });
  });

  it("should throw error for invalid route patterns", () => {
    const routes: RoutesConfig = {
      "GET ": "$0.01", // Invalid pattern with no path
    };

    expect(() => computeRoutePatterns(routes)).toThrow("Invalid route pattern: GET ");
  });
});

describe("findMatchingRoute", () => {
  const routes = {
    "GET /api/test": "$0.01",
    "POST /api/test": "$0.02",
    "/api/wildcard": "$0.03",
  };
  const routePatterns = computeRoutePatterns(routes);

  it("should return undefined when no routes match", () => {
    const result = findMatchingRoute(routePatterns, "/not/api", "GET");
    expect(result).toBeUndefined();
  });

  it("should match routes with wildcard verbs", () => {
    const result = findMatchingRoute(routePatterns, "/api/wildcard", "PUT");
    expect(result).toEqual(routePatterns[2]);
  });

  it("should match routes with specific verbs", () => {
    const result = findMatchingRoute(routePatterns, "/api/test", "POST");
    expect(result).toEqual(routePatterns[1]);
  });

  it("should not match routes with wrong verbs", () => {
    const result = findMatchingRoute(routePatterns, "/api/test", "PUT");
    expect(result).toBeUndefined();
  });

  it("should handle case-insensitive method matching", () => {
    const result = findMatchingRoute(routePatterns, "/api/test", "post");
    expect(result).toEqual(routePatterns[1]);
  });

  it("should handle case-insensitive path matching", () => {
    const result = findMatchingRoute(routePatterns, "/API/test", "GET");
    expect(result).toEqual(routePatterns[0]);
  });

  it("should handle empty route patterns array", () => {
    const result = findMatchingRoute([], "/api/test", "GET");
    expect(result).toBeUndefined();
  });

  it("should normalize paths with multiple consecutive slashes", () => {
    const result = findMatchingRoute(routePatterns, "//api///test", "GET");
    expect(result).toEqual(routePatterns[0]);
  });

  it("should match paths with trailing slashes", () => {
    const result = findMatchingRoute(routePatterns, "/api/test/", "GET");
    expect(result).toEqual(routePatterns[0]);
  });

  it("should match paths with multiple trailing slashes", () => {
    const result = findMatchingRoute(routePatterns, "/api/test///", "GET");
    expect(result).toEqual(routePatterns[0]);
  });

  it("should match paths with trailing backslash", () => {
    const result = findMatchingRoute(routePatterns, "/api/test\\", "GET");
    expect(result).toEqual(routePatterns[0]);
  });

  it("should match paths with multiple trailing backslashes", () => {
    const result = findMatchingRoute(routePatterns, "/api/test\\\\", "GET");
    expect(result).toEqual(routePatterns[0]);
  });

  it("should match paths with multiple consecutive slashes", () => {
    const result = findMatchingRoute(routePatterns, "/api///test", "GET");
    expect(result).toEqual(routePatterns[0]);
  });

  it("should match paths with query parameters", () => {
    const result = findMatchingRoute(routePatterns, "/api/test?foo=bar", "GET");
    expect(result).toEqual(routePatterns[0]);
  });

  it("should match paths with hash fragments", () => {
    const result = findMatchingRoute(routePatterns, "/api/test#section", "GET");
    expect(result).toEqual(routePatterns[0]);
  });

  // URL-encoded path tests
  it("should match basic URL-encoded paths", () => {
    const result = findMatchingRoute(routePatterns, "/api/%74est", "GET");
    expect(result).toEqual(routePatterns[0]);
  });

  it("should match paths with multiple URL-encoded characters", () => {
    const result = findMatchingRoute(routePatterns, "/api/%74%65%73%74", "GET"); // /api/test encoded
    expect(result).toEqual(routePatterns[0]);
  });

  it("should match paths with URL-encoded slashes and backslashes", () => {
    // Test various combinations of encoded slashes and backslashes
    const tests = [
      "%2Fapi%2Ftest", // /api/test (all slashes encoded)
      "%5Capi%5Ctest", // \api\test (all backslashes encoded)
      "%2Fapi/test", // /api/test (mixed encoded and raw slashes)
      "%5Capi\\test", // \api\test (mixed encoded and raw backslashes)
      "/api%2Ftest", // /api/test (mixed raw and encoded slashes)
      "\\api%5Ctest", // \api\test (mixed raw and encoded backslashes)
      "%2Fapi%5Ctest", // /api\test (mixed encoded slash and backslash)
      "/api%2F%2Ftest", // /api//test (multiple encoded slashes)
      "\\api%5C%5Ctest", // \api\\test (multiple encoded backslashes)
    ];

    // All should match the same route
    tests.forEach(path => {
      const result = findMatchingRoute(routePatterns, path, "GET");
      expect(result).toEqual(routePatterns[0]);
    });
  });

  it("should match partially URL-encoded paths", () => {
    const result = findMatchingRoute(routePatterns, "/api/t%65st", "GET"); // /api/test with just 'e' encoded
    expect(result).toEqual(routePatterns[0]);
  });

  it("should match paths with URL-encoded query parameters", () => {
    const result = findMatchingRoute(routePatterns, "/api/test?foo%3Dbar", "GET"); // foo=bar with = encoded
    expect(result).toEqual(routePatterns[0]);
  });

  it("should match paths with mixed URL-encoded and special characters", () => {
    const result = findMatchingRoute(routePatterns, "/api/%74est%20with%20spaces", "GET");
    expect(result).toBeUndefined(); // Should not match as the pattern doesn't include spaces
  });

  it("should handle malformed URL-encoded sequences", () => {
    const result = findMatchingRoute(routePatterns, "/api/%XX", "GET");
    expect(result).toBeUndefined(); // Should not match as %XX is not a valid encoding
  });

  describe("malformed percent-encoding", () => {
    const paywallRoutes = {
      "/paywall/[param]": "$0.01",
      "/api/protected/*": "$0.02",
    };
    const paywallPatterns = computeRoutePatterns(paywallRoutes);

    it("should match route with trailing malformed %", () => {
      const result = findMatchingRoute(paywallPatterns, "/paywall/test%", "GET");
      expect(result).toBeDefined();
      expect(result?.config.price).toBe("$0.01");
    });

    it("should match route with malformed %c0 sequence", () => {
      const result = findMatchingRoute(paywallPatterns, "/paywall/test%c0", "GET");
      expect(result).toBeDefined();
      expect(result?.config.price).toBe("$0.01");
    });

    it("should match route with multiple malformed sequences", () => {
      const result = findMatchingRoute(paywallPatterns, "/paywall/test%c0%c1%", "GET");
      expect(result).toBeDefined();
      expect(result?.config.price).toBe("$0.01");
    });

    it("should match wildcard route with malformed encoding", () => {
      const result = findMatchingRoute(paywallPatterns, "/api/protected/resource%", "GET");
      expect(result).toBeDefined();
      expect(result?.config.price).toBe("$0.02");
    });

    it("should match route with malformed encoding in middle of path", () => {
      const result = findMatchingRoute(paywallPatterns, "/paywall/te%st", "GET");
      expect(result).toBeDefined();
    });
  });
});

describe("getDefaultAsset", () => {
  it("should return Base USDC asset details", () => {
    const result = getDefaultAsset("base");

    expect(result).toEqual({
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
      eip712: {
        name: "USD Coin",
        version: "2",
      },
    });
  });

  it("should return Base Sepolia USDC asset details", () => {
    const result = getDefaultAsset("base-sepolia");

    expect(result).toEqual({
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
      eip712: {
        name: "USDC",
        version: "2",
      },
    });
  });

  it("should return Sei Testnet USDC asset details", () => {
    const result = getDefaultAsset("sei-testnet");

    expect(result).toEqual({
      address: "0x4fcf1784b31630811181f670aea7a7bef803eaed",
      decimals: 6,
      eip712: {
        name: "USDC",
        version: "2",
      },
    });
  });

  it("should return Sei USDC asset details", () => {
    const result = getDefaultAsset("sei");

    expect(result).toEqual({
      address: "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392",
      decimals: 6,
      eip712: {
        name: "USDC",
        version: "2",
      },
    });
  });

  it("should return Polygon Amoy USDC asset details", () => {
    const result = getDefaultAsset("polygon-amoy");
    expect(result).toEqual({
      address: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
      decimals: 6,
      eip712: {
        name: "USDC",
        version: "2",
      },
    });
  });

  it("should return Polygon mainnet USDC asset details", () => {
    const result = getDefaultAsset("polygon");
    expect(result).toEqual({
      address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      decimals: 6,
      eip712: {
        name: "USD Coin",
        version: "2",
      },
    });
  });

  it("should handle unknown networks", () => {
    expect(() => getDefaultAsset("unknown" as Network)).toThrow("Unsupported network: unknown");
  });
});

describe("processPriceToAtomicAmount", () => {
  it("should handle string price in dollars", () => {
    const result = processPriceToAtomicAmount("$0.01", "base-sepolia");
    expect(result).toEqual({
      maxAmountRequired: "10000",
      asset: {
        address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        decimals: 6,
        eip712: {
          name: "USDC",
          version: "2",
        },
      },
    });
  });

  it("should handle number price in dollars", () => {
    const result = processPriceToAtomicAmount(0.01, "base-sepolia");
    expect(result).toEqual({
      maxAmountRequired: "10000",
      asset: {
        address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        decimals: 6,
        eip712: {
          name: "USDC",
          version: "2",
        },
      },
    });
  });

  it("should handle token amount object", () => {
    const tokenAmount = {
      amount: "1000000",
      asset: {
        address: "0x1234567890123456789012345678901234567890" as `0x${string}`,
        decimals: 18,
        eip712: {
          name: "Custom Token",
          version: "1",
        },
      },
    };
    const result = processPriceToAtomicAmount(tokenAmount, "base-sepolia");
    expect(result).toEqual({
      maxAmountRequired: "1000000",
      asset: tokenAmount.asset,
    });
  });

  it("should handle invalid price format", () => {
    const result = processPriceToAtomicAmount("invalid", "base-sepolia");
    expect(result).toEqual({
      error: expect.stringContaining("Invalid price"),
    });
  });

  it("should handle negative price", () => {
    const result = processPriceToAtomicAmount("-$0.01", "base-sepolia");
    expect(result).toEqual({
      error: expect.stringContaining("Invalid price"),
    });
  });

  it("should handle zero price", () => {
    const result = processPriceToAtomicAmount("$0", "base-sepolia");
    expect(result).toEqual({
      error: expect.stringContaining("Number must be greater than or equal to 0.0001"),
    });
  });
});
