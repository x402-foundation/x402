/**
 * Tests for Bazaar discovery extraction in runtimes without code generation
 */

import { describe, it, expect, vi } from "vitest";
import { BAZAAR, declareDiscoveryExtension, extractDiscoveryInfo } from "../src/bazaar/index";

describe("Bazaar discovery extraction without runtime code generation", () => {
  it("should extract info when runtime code generation is unavailable", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const declared = declareDiscoveryExtension({
      input: { city: "NYC" },
      inputSchema: { properties: { city: { type: "string" } } },
    });
    const paymentPayload = {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:8453" as unknown,
      payload: {},
      accepted: {} as unknown,
      resource: { url: "https://api.example.com/weather" },
      extensions: { [BAZAAR.key]: declared.bazaar },
    };

    try {
      vi.stubGlobal("Function", function () {
        throw new EvalError("Code generation from strings disallowed for this context");
      });
      const discovered = extractDiscoveryInfo(paymentPayload, {} as unknown);
      expect(discovered).not.toBeNull();
      expect(discovered!.discoveryInfo).toEqual(declared.bazaar.info);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      errorSpy.mockRestore();
    }
  });

  it("should keep protocol checks when runtime code generation is unavailable", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const paymentPayload = {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:8453" as unknown,
      payload: {},
      accepted: {} as unknown,
      resource: { url: "https://api.example.com/weather" },
      extensions: { [BAZAAR.key]: { info: { input: { type: "grpc" } }, schema: {} } },
    };

    try {
      vi.stubGlobal("Function", function () {
        throw new EvalError("Code generation from strings disallowed for this context");
      });
      expect(extractDiscoveryInfo(paymentPayload, {} as unknown)).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("input.type");
    } finally {
      vi.unstubAllGlobals();
      warnSpy.mockRestore();
    }
  });
});
