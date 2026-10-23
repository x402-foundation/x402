import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCESS_CONTROL_EXPOSE_HEADERS,
  applyPaymentResponseHeaders,
  withPaymentCorsExposeHeaders,
  x402HTTPResourceServer,
} from "../../../src/http/x402HTTPResourceServer";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import { Network } from "../../../src/types";
import { decodePaymentRequiredHeader } from "../../../src/http";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildSupportedResponse,
} from "../../mocks";

function exposedNames(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(name => name.trim().toLowerCase())
    .filter(Boolean);
}

describe("payment CORS expose headers", () => {
  it("names both protocol headers and merges an existing expose list once", () => {
    const merged = withPaymentCorsExposeHeaders(
      {
        "PAYMENT-REQUIRED": "encoded",
        "access-control-expose-headers": "X-Custom, payment-required",
      },
      "X-Other, PAYMENT-RESPONSE",
    );

    expect(merged["access-control-expose-headers"]).toBe(
      "X-Other, PAYMENT-RESPONSE, X-Custom, payment-required",
    );
    expect(merged[ACCESS_CONTROL_EXPOSE_HEADERS]).toBeUndefined();
  });

  it("merges onto a response that already exposes an app header", () => {
    const written: Record<string, string> = {
      "Access-Control-Expose-Headers": "X-Custom",
    };
    applyPaymentResponseHeaders(
      withPaymentCorsExposeHeaders({ "PAYMENT-RESPONSE": "receipt" }),
      name => written[name],
      (name, value) => {
        written[name] = value;
      },
    );

    expect(written["PAYMENT-RESPONSE"]).toBe("receipt");
    expect(exposedNames(written[ACCESS_CONTROL_EXPOSE_HEADERS])).toEqual([
      "x-custom",
      "payment-required",
      "payment-response",
    ]);
  });

  describe("402 response", () => {
    let httpServer: x402HTTPResourceServer;

    beforeEach(async () => {
      const network = "eip155:8453" as Network;
      const facilitator = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network }],
        }),
      );
      const resourceServer = new x402ResourceServer(facilitator);
      resourceServer.register(network, new MockSchemeNetworkServer("exact"));
      await resourceServer.initialize();
      httpServer = new x402HTTPResourceServer(resourceServer, {
        "GET /api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00",
            network,
          },
        },
      });
    });

    it("exposes PAYMENT-REQUIRED on the unpaid response", async () => {
      const result = await httpServer.processHTTPRequest({
        path: "/api/test",
        method: "GET",
        adapter: {
          getHeader: () => undefined,
          getMethod: () => "GET",
          getPath: () => "/api/test",
          getUrl: () => "https://example.com/api/test",
          getAcceptHeader: () => "application/json",
          getUserAgent: () => "vitest",
        },
      });

      expect(result.type).toBe("payment-error");
      if (result.type !== "payment-error") {
        return;
      }
      const expose = result.response.headers[ACCESS_CONTROL_EXPOSE_HEADERS];
      expect(exposedNames(expose)).toEqual(["payment-required", "payment-response"]);
      expect(result.response.headers["PAYMENT-REQUIRED"]).toBeTruthy();
      expect(decodePaymentRequiredHeader(result.response.headers["PAYMENT-REQUIRED"])).toBeTruthy();
    });
  });
});
