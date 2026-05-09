import { beforeEach, describe, expect, it } from "vitest";
import { x402HTTPResourceServer, HTTPAdapter } from "../../../src/http/x402HTTPResourceServer";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import { FacilitatorResponseError, Network } from "../../../src/types";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildPaymentPayload,
  buildPaymentRequirements,
  buildSupportedResponse,
} from "../../mocks";
import { encodePaymentSignatureHeader } from "../../../src/http";

class MockHTTPAdapter implements HTTPAdapter {
  constructor(private readonly headers: Record<string, string> = {}) {}

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  getMethod(): string {
    return "GET";
  }

  getPath(): string {
    return "/api/test";
  }

  getUrl(): string {
    return "https://example.com/api/test";
  }

  getAcceptHeader(): string {
    return "application/json";
  }

  getUserAgent(): string {
    return "Vitest";
  }
}

describe("x402HTTPResourceServer facilitator response errors", () => {
  let resourceServer: x402ResourceServer;
  let facilitator: MockFacilitatorClient;
  let httpServer: x402HTTPResourceServer;
  const network = "eip155:8453" as Network;

  beforeEach(async () => {
    facilitator = new MockFacilitatorClient(
      buildSupportedResponse({
        kinds: [{ x402Version: 2, scheme: "exact", network }],
      }),
    );

    resourceServer = new x402ResourceServer(facilitator);
    resourceServer.register(network, new MockSchemeNetworkServer("exact"));
    await resourceServer.initialize();

    httpServer = new x402HTTPResourceServer(resourceServer, {
      "/api/test": {
        accepts: {
          scheme: "exact",
          payTo: "0xabc",
          price: "$1.00",
          network,
        },
      },
    });
  });

  it("rethrows FacilitatorResponseError during verification", async () => {
    facilitator.setVerifyResponse(
      new FacilitatorResponseError("Facilitator verify returned invalid JSON: not-json"),
    );

    const accepted = buildPaymentRequirements({
      scheme: "exact",
      network,
      payTo: "0xabc",
      asset: "USDC",
      amount: "1000000",
    });
    const payload = buildPaymentPayload({
      x402Version: 2,
      accepted,
    });

    await expect(
      httpServer.processHTTPRequest({
        adapter: new MockHTTPAdapter({
          "payment-signature": encodePaymentSignatureHeader(payload),
        }),
        path: "/api/test",
        method: "GET",
        paymentHeader: encodePaymentSignatureHeader(payload),
      }),
    ).rejects.toThrow(FacilitatorResponseError);
  });

  it("rethrows FacilitatorResponseError during settlement", async () => {
    facilitator.setSettleResponse(
      new FacilitatorResponseError('Facilitator settle returned invalid data: {"success":true}'),
    );

    const accepted = buildPaymentRequirements({
      scheme: "exact",
      network,
      payTo: "0xabc",
      asset: "USDC",
      amount: "1000000",
    });
    await expect(
      httpServer.processSettlement(buildPaymentPayload({ x402Version: 2, accepted }), accepted),
    ).rejects.toThrow(FacilitatorResponseError);
  });
});
