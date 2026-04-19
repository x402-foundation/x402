import { describe, it, expect } from "vitest";
import { generateOpenAPISpec } from "../../../src/openapi";

describe("generateOpenAPISpec", () => {
  it("generates a minimal spec from simple routes", () => {
    const routes = {
      "GET /weather": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: "eip155:84532",
          payTo: "0xabc",
        },
        description: "Weather data",
        mimeType: "application/json",
      },
    };

    const spec = generateOpenAPISpec(routes);

    expect(spec.openapi).toBe("3.1.0");
    expect((spec.info as Record<string, string>).title).toBe("x402 API");
    expect((spec.info as Record<string, string>).version).toBe("1.0.0");

    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths["/weather"]).toBeDefined();
    expect(paths["/weather"].get).toBeDefined();
    expect(paths["/weather"].get.summary).toBe("Weather data");

    const paymentInfo = paths["/weather"].get["x-payment-info"] as Record<string, unknown>;
    expect(paymentInfo).toBeDefined();
    expect((paymentInfo.price as Record<string, string>).mode).toBe("fixed");
    expect((paymentInfo.price as Record<string, string>).amount).toBe("0.001");
  });

  it("handles path parameters", () => {
    const routes = {
      "GET /weather/:city": {
        accepts: {
          scheme: "exact",
          price: "$0.01",
          network: "eip155:84532",
          payTo: "0xabc",
        },
        description: "City weather",
      },
    };

    const spec = generateOpenAPISpec(routes);
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;

    expect(paths["/weather/{city}"]).toBeDefined();
    const params = paths["/weather/{city}"].get.parameters as Array<Record<string, unknown>>;
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe("city");
    expect(params[0].in).toBe("path");
    expect(params[0].required).toBe(true);
  });

  it("uses custom options", () => {
    const routes = {
      "GET /data": {
        accepts: { scheme: "exact", price: "$0.05", network: "eip155:84532", payTo: "0x1" },
      },
    };

    const spec = generateOpenAPISpec(routes, {
      title: "My API",
      version: "2.0.0",
      description: "A paid API",
      serverUrl: "https://api.example.com",
    });

    expect((spec.info as Record<string, string>).title).toBe("My API");
    expect((spec.info as Record<string, string>).version).toBe("2.0.0");
    expect((spec.info as Record<string, string>).description).toBe("A paid API");
    expect((spec.servers as Array<Record<string, string>>)[0].url).toBe("https://api.example.com");
  });

  it("handles multiple payment options", () => {
    const routes = {
      "GET /data": {
        accepts: [
          { scheme: "exact", price: "$0.001", network: "eip155:84532", payTo: "0xabc" },
          { scheme: "exact", price: "$0.001", network: "solana:mainnet", payTo: "sol123" },
        ],
      },
    };

    const spec = generateOpenAPISpec(routes);
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const paymentInfo = paths["/data"].get["x-payment-info"] as Record<string, unknown>;

    // Uses first option's price
    expect((paymentInfo.price as Record<string, string>).amount).toBe("0.001");
    expect(paymentInfo.protocols).toEqual([{ x402: {} }]);
  });

  it("handles dynamic prices gracefully", () => {
    const routes = {
      "POST /compute": {
        accepts: {
          scheme: "exact",
          price: () => "$1.00", // dynamic
          network: "eip155:84532",
          payTo: "0xabc",
        },
      },
    };

    const spec = generateOpenAPISpec(routes);
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const paymentInfo = paths["/compute"].post["x-payment-info"] as Record<string, unknown>;

    // Dynamic prices result in mode: "dynamic"
    expect((paymentInfo.price as Record<string, string>).mode).toBe("dynamic");
  });

  it("handles single route config (wildcard)", () => {
    const routes = {
      accepts: { scheme: "exact", price: "$0.01", network: "eip155:84532", payTo: "0x1" },
      description: "All endpoints",
    };

    const spec = generateOpenAPISpec(routes);
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;

    expect(paths["/"]).toBeDefined();
    expect(paths["/"].get.summary).toBe("All endpoints");
  });

  it("includes 402 in responses", () => {
    const routes = {
      "GET /api": {
        accepts: { scheme: "exact", price: "$0.01", network: "eip155:84532", payTo: "0x1" },
      },
    };

    const spec = generateOpenAPISpec(routes);
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const responses = paths["/api"].get.responses as Record<string, Record<string, string>>;

    expect(responses["402"]).toBeDefined();
    expect(responses["402"].description).toBe("Payment Required");
  });
});
