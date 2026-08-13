import { describe, it, expect } from "vitest";
import { x402Client } from "../../../src/client/x402Client";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "../../../src/http";
import { x402HTTPClient } from "../../../src/http/x402HTTPClient";
import { buildPaymentRequired, buildSettleResponse } from "../../mocks";

describe("x402HTTPClient.parsePaymentResult", () => {
  const httpClient = new x402HTTPClient(new x402Client());

  it("decodes the PAYMENT-RESPONSE settlement into header on success", () => {
    const settleResponse = buildSettleResponse({ success: true, transaction: "0xabc" });
    const body = { temperature: 72 };
    const headers: Record<string, string> = {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader(settleResponse),
    };

    const result = httpClient.parsePaymentResult({
      status: 200,
      getHeader: name => headers[name] ?? null,
      body,
    });

    expect(result).toEqual({
      status: 200,
      paymentStatus: "settled",
      body,
      header: settleResponse,
    });
  });

  it("decodes a failed settlement into header", () => {
    const settleResponse = buildSettleResponse({
      success: false,
      errorReason: "insufficient_funds",
      errorMessage: "Not enough USDC",
    });
    const body = { error: "payment failed" };
    const headers: Record<string, string> = {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader(settleResponse),
    };

    const result = httpClient.parsePaymentResult({
      status: 402,
      getHeader: name => headers[name] ?? null,
      body,
    });

    expect(result).toEqual({
      status: 402,
      paymentStatus: "settle_failed",
      body,
      header: settleResponse,
    });
    expect(result.header).toMatchObject({
      success: false,
      errorReason: "insufficient_funds",
      errorMessage: "Not enough USDC",
    });
  });

  it("decodes the PAYMENT-REQUIRED declaration into header on 402", () => {
    const paymentRequired = buildPaymentRequired({
      error: "invalid_exact_evm_payload_signature",
    });
    const body = {};
    const headers: Record<string, string> = {
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
    };

    const result = httpClient.parsePaymentResult({
      status: 402,
      getHeader: name => headers[name] ?? null,
      body,
    });

    expect(result).toEqual({
      status: 402,
      paymentStatus: "payment_required",
      body,
      header: paymentRequired,
    });
    expect(result.header).toMatchObject({ error: "invalid_exact_evm_payload_signature" });
  });

  it("ignores PAYMENT-REQUIRED on non-402 responses", () => {
    const paymentRequired = buildPaymentRequired();
    const body = { message: "ok" };
    const headers: Record<string, string> = {
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
    };

    const result = httpClient.parsePaymentResult({
      status: 200,
      getHeader: name => headers[name] ?? null,
      body,
    });

    expect(result).toEqual({ status: 200, paymentStatus: "none", body, header: undefined });
  });

  it("leaves header undefined when no payment header is present", () => {
    const body = { error: "internal server error" };

    const result = httpClient.parsePaymentResult({
      status: 500,
      getHeader: () => null,
      body,
    });

    expect(result).toEqual({ status: 500, paymentStatus: "none", body, header: undefined });
  });

  it("leaves header undefined for a 2xx response without payment headers", () => {
    const body = { message: "ok" };

    const result = httpClient.parsePaymentResult({
      status: 200,
      getHeader: () => null,
      body,
    });

    expect(result).toEqual({ status: 200, paymentStatus: "none", body, header: undefined });
  });
});
