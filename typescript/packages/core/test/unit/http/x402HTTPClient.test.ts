import { describe, it, expect, vi } from "vitest";
import { x402Client } from "../../../src/client/x402Client";
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "../../../src/http";
import { x402HTTPClient } from "../../../src/http/x402HTTPClient";
import { buildPaymentPayload, buildPaymentRequired, buildSettleResponse } from "../../mocks";

describe("x402HTTPClient", () => {
  describe("encodePaymentSignatureHeader", () => {
    it("uses PAYMENT-SIGNATURE for v2 payloads", () => {
      const httpClient = new x402HTTPClient(new x402Client());
      const payload = buildPaymentPayload({ x402Version: 2 });

      const headers = httpClient.encodePaymentSignatureHeader(payload);

      expect(headers).toEqual({
        "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload),
      });
    });

    it("uses X-PAYMENT for v1 payloads", () => {
      const httpClient = new x402HTTPClient(new x402Client());
      const payload = buildPaymentPayload({ x402Version: 1 });

      const headers = httpClient.encodePaymentSignatureHeader(payload);

      expect(headers).toEqual({
        "X-PAYMENT": encodePaymentSignatureHeader(payload),
      });
    });

    it("rejects unsupported protocol versions", () => {
      const httpClient = new x402HTTPClient(new x402Client());
      const payload = buildPaymentPayload({ x402Version: 99 as 2 });

      expect(() => httpClient.encodePaymentSignatureHeader(payload)).toThrow(
        "Unsupported x402 version: 99",
      );
    });
  });

  describe("getPaymentRequiredResponse", () => {
    it("decodes v2 PAYMENT-REQUIRED headers", () => {
      const httpClient = new x402HTTPClient(new x402Client());
      const paymentRequired = buildPaymentRequired({ error: "invalid_signature" });
      const headers = {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
      };

      expect(
        httpClient.getPaymentRequiredResponse(
          name => headers[name as keyof typeof headers] ?? null,
        ),
      ).toEqual(paymentRequired);
    });

    it("falls back to a v1 JSON body when no v2 header is present", () => {
      const httpClient = new x402HTTPClient(new x402Client());
      const paymentRequired = buildPaymentRequired({ x402Version: 1 });

      expect(httpClient.getPaymentRequiredResponse(() => null, paymentRequired)).toEqual(
        paymentRequired,
      );
    });

    it("throws when neither a v2 header nor a v1 body is available", () => {
      const httpClient = new x402HTTPClient(new x402Client());

      expect(() => httpClient.getPaymentRequiredResponse(() => null, { message: "oops" })).toThrow(
        "Invalid payment required response",
      );
    });
  });

  describe("getPaymentSettleResponse", () => {
    it("decodes v2 PAYMENT-RESPONSE headers", () => {
      const httpClient = new x402HTTPClient(new x402Client());
      const settleResponse = buildSettleResponse({ success: true, transaction: "0xv2" });
      const headers = {
        "PAYMENT-RESPONSE": encodePaymentResponseHeader(settleResponse),
      };

      expect(
        httpClient.getPaymentSettleResponse(name => headers[name as keyof typeof headers] ?? null),
      ).toEqual(settleResponse);
    });

    it("decodes legacy v1 X-PAYMENT-RESPONSE headers", () => {
      const httpClient = new x402HTTPClient(new x402Client());
      const settleResponse = buildSettleResponse({ success: true, transaction: "0xv1" });
      const headers = {
        "X-PAYMENT-RESPONSE": encodePaymentResponseHeader(settleResponse),
      };

      expect(
        httpClient.getPaymentSettleResponse(name => headers[name as keyof typeof headers] ?? null),
      ).toEqual(settleResponse);
    });

    it("throws when no settlement header is present", () => {
      const httpClient = new x402HTTPClient(new x402Client());

      expect(() => httpClient.getPaymentSettleResponse(() => null)).toThrow(
        "Payment response header not found",
      );
    });
  });

  describe("processPaymentResult", () => {
    it("returns early for v1 without invoking payment response hooks", async () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      const hook = vi.fn();
      client.onPaymentResponse(hook);

      const settleResponse = buildSettleResponse({ success: true, transaction: "0xv1" });
      const payload = buildPaymentPayload({ x402Version: 1 });
      const headers = {
        "X-PAYMENT-RESPONSE": encodePaymentResponseHeader(settleResponse),
      };

      const result = await httpClient.processPaymentResult(
        payload,
        name => headers[name as keyof typeof headers] ?? null,
        200,
      );

      expect(result).toEqual({ recovered: false, settleResponse });
      expect(hook).not.toHaveBeenCalled();
    });

    it("passes settle and payment-required context into v2 payment response hooks", async () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      const requirements = buildPaymentPayload().accepted!;
      const paymentRequired = buildPaymentRequired({ error: "settlement_rejected" });
      const settleResponse = buildSettleResponse({
        success: false,
        errorReason: "insufficient_funds",
      });
      const payload = buildPaymentPayload({ accepted: requirements });
      const headers = {
        "PAYMENT-RESPONSE": encodePaymentResponseHeader(settleResponse),
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
      };

      let receivedContext: unknown;
      client.onPaymentResponse(async ctx => {
        receivedContext = ctx;
      });

      const result = await httpClient.processPaymentResult(
        payload,
        name => headers[name as keyof typeof headers] ?? null,
        402,
      );

      expect(result.recovered).toBe(false);
      expect(result.settleResponse).toEqual(settleResponse);
      expect(receivedContext).toMatchObject({
        paymentPayload: payload,
        requirements,
        settleResponse,
      });
    });

    it("does not decode payment-required on v2 when a settle header is present", async () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      const settleResponse = buildSettleResponse({ success: true, transaction: "0xok" });
      const paymentRequired = buildPaymentRequired({ error: "should_not_be_read" });
      const payload = buildPaymentPayload();
      const headers = {
        "PAYMENT-RESPONSE": encodePaymentResponseHeader(settleResponse),
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
      };

      let receivedContext: unknown;
      client.onPaymentResponse(async ctx => {
        receivedContext = ctx;
      });

      await httpClient.processPaymentResult(
        payload,
        name => headers[name as keyof typeof headers] ?? null,
        402,
      );

      expect(receivedContext).toMatchObject({
        settleResponse,
      });
      expect(receivedContext).not.toHaveProperty("paymentRequired");
    });

    it("signals recovery when a v2 payment response hook returns recovered", async () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      const payload = buildPaymentPayload();

      client.onPaymentResponse(async () => ({ recovered: true }));

      const result = await httpClient.processPaymentResult(payload, () => null, 402);

      expect(result).toEqual({ recovered: true, settleResponse: undefined });
    });

    it("throws when a v2 payload is missing accepted requirements", async () => {
      const httpClient = new x402HTTPClient(new x402Client());
      const payload = buildPaymentPayload({ accepted: undefined });

      await expect(httpClient.processPaymentResult(payload, () => null, 402)).rejects.toThrow(
        "Invalid x402 v2 payment payload: missing `accepted`",
      );
    });
  });

  describe("parsePaymentResult edge cases", () => {
    const httpClient = new x402HTTPClient(new x402Client());

    it("decodes legacy v1 settlement headers", () => {
      const settleResponse = buildSettleResponse({ success: true, transaction: "0xv1" });
      const headers = {
        "X-PAYMENT-RESPONSE": encodePaymentResponseHeader(settleResponse),
      };

      const result = httpClient.parsePaymentResult({
        status: 200,
        getHeader: name => headers[name as keyof typeof headers] ?? null,
        body: {},
      });

      expect(result.paymentStatus).toBe("settled");
      expect(result.header).toEqual(settleResponse);
    });

    it("falls back to a v1 JSON body on 402 when settlement headers are absent", () => {
      const paymentRequired = buildPaymentRequired({
        x402Version: 1,
        error: "expired_authorization",
      });

      const result = httpClient.parsePaymentResult({
        status: 402,
        getHeader: () => null,
        body: paymentRequired,
      });

      expect(result.paymentStatus).toBe("payment_required");
      expect(result.header).toEqual(paymentRequired);
    });

    it("leaves payment status none when a 402 has no decodable payment headers or body", () => {
      const result = httpClient.parsePaymentResult({
        status: 402,
        getHeader: () => null,
        body: { message: "forbidden" },
      });

      expect(result).toEqual({
        status: 402,
        paymentStatus: "none",
        body: { message: "forbidden" },
        header: undefined,
      });
    });
  });

  describe("processResponse", () => {
    it("parses JSON bodies when content-type is application/json", async () => {
      const httpClient = new x402HTTPClient(new x402Client());
      const settleResponse = buildSettleResponse({ success: true, transaction: "0xjson" });
      const response = new Response(JSON.stringify({ temperature: 72 }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "PAYMENT-RESPONSE": encodePaymentResponseHeader(settleResponse),
        },
      });

      const result = await httpClient.processResponse(response);

      expect(result.body).toEqual({ temperature: 72 });
      expect(result.paymentStatus).toBe("settled");
      expect(result.header).toEqual(settleResponse);
    });

    it("parses non-JSON bodies as text", async () => {
      const httpClient = new x402HTTPClient(new x402Client());
      const response = new Response("plain text payload", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });

      const result = await httpClient.processResponse(response);

      expect(result.body).toBe("plain text payload");
      expect(result.paymentStatus).toBe("none");
    });
  });
});
