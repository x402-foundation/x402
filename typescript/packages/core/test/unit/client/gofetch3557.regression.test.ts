import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { x402Client } from "../../../src/client/x402Client";
import { x402HTTPClient } from "../../../src/http/x402HTTPClient";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "../../../src/http";
import { MockSchemeNetworkClient } from "../../mocks/generic/MockSchemeClient";
import type { PaymentRequired } from "../../../src/types/payments";

function loadGofetchPaymentRequired(): PaymentRequired {
  return JSON.parse(
    readFileSync(
      new URL("../../fixtures/gofetch402-payment-required.json", import.meta.url),
      "utf8",
    ),
  ) as PaymentRequired;
}

describe("issue #3557 bazaar extension echo", () => {
  it("preserves extensions.bazaar through parse, createPaymentPayload, and PAYMENT-SIGNATURE encode", async () => {
    const body = loadGofetchPaymentRequired();

    const httpClient = new x402HTTPClient(new x402Client());
    const paymentRequired = httpClient.getPaymentRequiredResponse(
      name => (name === "PAYMENT-REQUIRED" ? encodePaymentRequiredHeader(body) : null),
      body,
    );

    expect(paymentRequired.extensions?.bazaar).toBeDefined();

    const client = new x402Client();
    client.register("eip155:8453", new MockSchemeNetworkClient("exact"));
    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    expect(paymentPayload.extensions?.bazaar).toEqual(paymentRequired.extensions?.bazaar);

    const decoded = decodePaymentSignatureHeader(encodePaymentSignatureHeader(paymentPayload));
    expect(decoded.extensions?.bazaar).toEqual(paymentRequired.extensions?.bazaar);
  });

  it("uses v2 JSON body when PAYMENT-REQUIRED header is unavailable (e.g. CORS)", async () => {
    const body = loadGofetchPaymentRequired();

    const httpClient = new x402HTTPClient(new x402Client());
    const paymentRequired = httpClient.getPaymentRequiredResponse(() => null, body);

    expect(paymentRequired.extensions?.bazaar).toEqual(body.extensions?.bazaar);

    const client = new x402Client();
    client.register("eip155:8453", new MockSchemeNetworkClient("exact"));
    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    expect(paymentPayload.extensions?.bazaar).toEqual(body.extensions?.bazaar);
  });

  it("merges extensions from v2 body when header omits them", async () => {
    const body = loadGofetchPaymentRequired();
    const headerOnly: PaymentRequired = {
      x402Version: body.x402Version,
      error: body.error,
      resource: body.resource,
      accepts: body.accepts,
    };

    const httpClient = new x402HTTPClient(new x402Client());
    const paymentRequired = httpClient.getPaymentRequiredResponse(
      name => (name === "PAYMENT-REQUIRED" ? encodePaymentRequiredHeader(headerOnly) : null),
      body,
    );

    expect(paymentRequired.extensions?.bazaar).toEqual(body.extensions?.bazaar);
  });
});
