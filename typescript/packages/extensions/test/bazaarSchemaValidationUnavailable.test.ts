import { describe, it, expect, vi, beforeEach } from "vitest";

// Simulates Cloudflare Workers (`workerd`), which forbids `new Function()` and
// therefore makes Ajv's `compile()` throw instead of returning a validator.
// See https://github.com/x402-foundation/x402/issues/3029
vi.mock("ajv/dist/2020.js", () => {
  return {
    default: class MockAjv {
      /** Mimics Ajv throwing when `new Function()` is disallowed. */
      compile() {
        throw new Error("Code generation from strings disallowed for this context");
      }
    },
  };
});

describe("bazaar schema validation on runtimes without dynamic code generation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("validateDiscoveryExtension reports `unavailable` instead of `valid: false` for schema reasons", async () => {
    const { validateDiscoveryExtension } = await import("../src/bazaar/facilitator");

    const result = validateDiscoveryExtension({
      info: { input: { type: "http", method: "GET" } },
      schema: { type: "object" },
    } as never);

    expect(result.valid).toBe(false);
    expect(result.unavailable).toBe(true);
  });

  it("validateBazaarRouteExtensions warns once for the whole call, not once per route", async () => {
    const { validateBazaarRouteExtensions } = await import("../src/bazaar/startupValidation");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const routeExtension = {
      info: { input: { type: "http", method: "GET" } },
      schema: { type: "object" },
    };
    const routes = {
      "GET /a": {
        accepts: [{ scheme: "exact", payTo: "0x1", price: "$0.01", network: "eip155:1" as const }],
        extensions: { bazaar: routeExtension },
      },
      "GET /b": {
        accepts: [{ scheme: "exact", payTo: "0x1", price: "$0.01", network: "eip155:1" as const }],
        extensions: { bazaar: routeExtension },
      },
      "GET /c": {
        accepts: [{ scheme: "exact", payTo: "0x1", price: "$0.01", network: "eip155:1" as const }],
        extensions: { bazaar: routeExtension },
      },
    };

    validateBazaarRouteExtensions(routes);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("unavailable in this runtime");
    spy.mockRestore();
  });

  it("still runs non-schema checks on routes after the first schema-unavailable warning", async () => {
    const { validateBazaarRouteExtensions } = await import("../src/bazaar/startupValidation");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const validExtension = {
      info: { input: { type: "http", method: "GET" } },
      schema: { type: "object" },
    };
    const routes = {
      "GET /a": {
        accepts: [{ scheme: "exact", payTo: "0x1", price: "$0.01", network: "eip155:1" as const }],
        extensions: { bazaar: validExtension },
      },
      "GET /b": {
        accepts: [{ scheme: "exact", payTo: "0x1", price: "$0.01", network: "eip155:1" as const }],
        // Malformed: missing "schema" field entirely, so this should hit the
        // "declares a bazaar extension but it is malformed" branch, which is
        // pure JS and unaffected by the ajv-unavailable condition on /a.
        extensions: { bazaar: { info: { input: { type: "http", method: "GET" } } } },
      },
    };

    validateBazaarRouteExtensions(routes);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toContain("unavailable in this runtime");
    expect(spy.mock.calls[1][0]).toContain('Route "GET /b"');
    expect(spy.mock.calls[1][0]).toContain("malformed");
    spy.mockRestore();
  });
});
