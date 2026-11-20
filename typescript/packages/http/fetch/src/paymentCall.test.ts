// Regression cases for per-call payment context (#3750). Adapted from the
// reference cases shared by @epistemedeus on the issue.
import { describe, expect, it, vi } from "vitest";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { Network, PaymentRequired, SchemeNetworkClient } from "@x402/core/types";
import { wrapFetchWithPayment } from "./index";
import { httpPaymentCall } from "./paymentCall";

const network = "test:network" as Network;

/**
 * A PaymentRequired with one test accept.
 *
 * @returns The PaymentRequired
 */
function required(): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: "https://pay.example/resource", description: "Test", mimeType: "text/plain" },
    accepts: [
      {
        scheme: "test-scheme",
        network,
        amount: "1000000",
        asset: "TEST",
        payTo: "test_recipient",
        maxTimeoutSeconds: 30,
        extra: {},
      },
    ],
  };
}

/**
 * A 402 response carrying the test PaymentRequired.
 *
 * @returns The response
 */
function paymentRequiredResponse(): Response {
  return new Response(null, {
    status: 402,
    headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required()) },
  });
}

/**
 * Polls until a condition holds.
 *
 * @param ready - Condition
 * @param what - Description for the timeout error
 */
async function waitFor(ready: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 1000) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/**
 * Resolves to how a promise settled, or "pending" after a timeout.
 *
 * @param promise - The promise
 * @param ms - Timeout
 * @returns The outcome
 */
function outcome(promise: Promise<unknown> | undefined, ms: number): Promise<string> {
  return Promise.race([
    (promise ?? Promise.resolve()).then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise<string>(resolve => setTimeout(() => resolve("pending"), ms)),
  ]);
}

describe("httpPaymentCall", () => {
  it("captures method, url and headers, and reads the body only when asked, once", async () => {
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });
    const request = new Request("https://pay.example/stream", {
      method: "POST",
      body: stream,
      duplex: "half",
      headers: { "X-Request-Id": "stream" },
    } as RequestInit);
    let bodySource: Request | undefined;
    const call = httpPaymentCall(request, () => {
      bodySource = request.clone();
      return bodySource;
    });

    expect(call).toMatchObject({ kind: "http", method: "POST", url: "https://pay.example/stream" });
    expect(call.headers["x-request-id"]).toBe("stream");
    expect(bodySource).toBeUndefined();
    expect(pulls).toBe(0);

    const first = await call.getBody?.();
    const second = await call.getBody?.();
    expect(pulls).toBe(1);
    expect(bodySource?.bodyUsed).toBe(true);
    expect(request.bodyUsed).toBe(false);
    expect(first).toEqual(new TextEncoder().encode("hello"));
    expect(second).toEqual(first);
    first![0] = 0;
    expect(second![0]).not.toBe(0);
  });

  it("omits getBody for a bodyless request", () => {
    const request = new Request("https://pay.example/get");
    expect(httpPaymentCall(request, () => request.clone()).getBody).toBeUndefined();
  });

  it("rejects an aborted or already used body without inventing bytes", async () => {
    const controller = new AbortController();
    const aborted = new Request("https://pay.example/abort", {
      method: "POST",
      body: "abc",
      signal: controller.signal,
    });
    const abortedBody = aborted.clone();
    controller.abort();
    const abortedCall = httpPaymentCall(aborted, () => abortedBody);
    await expect(abortedCall.getBody?.()).rejects.toBeTruthy();
    await expect(abortedCall.getBody?.()).rejects.toBeTruthy();

    const used = new Request("https://pay.example/used", { method: "POST", body: "abc" });
    const usedBody = used.clone();
    await usedBody.arrayBuffer();
    await expect(httpPaymentCall(used, () => usedBody).getBody?.()).rejects.toThrow(
      "request_body_already_used",
    );
  });

  it("honors a signal passed to getBody", async () => {
    const request = new Request("https://pay.example/own", { method: "POST", body: "abc" });
    const controller = new AbortController();
    controller.abort(new Error("caller_gave_up"));
    const call = httpPaymentCall(request, () => request.clone());
    await expect(call.getBody?.(controller.signal)).rejects.toThrow("caller_gave_up");
  });

  it("rejects a broken stream once and does not reread it", async () => {
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.error(new Error("stream_broken"));
      },
    });
    const request = new Request("https://pay.example/broken", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    const call = httpPaymentCall(request, () => request.clone());
    await expect(call.getBody?.()).rejects.toThrow("stream_broken");
    await expect(call.getBody?.()).rejects.toThrow("stream_broken");
    expect(pulls).toBe(1);
  });

  it("rejects a read aborted after it started and cancels the source", async () => {
    let pulls = 0;
    let cancels = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode("partial"));
          return;
        }
        return new Promise(() => undefined);
      },
      cancel() {
        cancels += 1;
      },
    });
    const controller = new AbortController();
    const request = new Request("https://pay.example/mid-abort", {
      method: "POST",
      body: stream,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit);
    const call = httpPaymentCall(request, () => request);
    const pending = call.getBody?.();
    await waitFor(() => pulls >= 2, "the hung pull");
    controller.abort();

    expect(await outcome(pending, 400)).toBe("rejected");
    expect(cancels).toBeGreaterThan(0);
    expect(await outcome(call.getBody?.(), 200)).toBe("rejected");
  });

  it("lets a later consumer's signal abort a read another consumer started", async () => {
    let pulls = 0;
    const stream = hangingStream(() => (pulls += 1));
    const request = new Request("https://pay.example/later-signal", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    const call = httpPaymentCall(request, () => request);
    const hookRead = call.getBody?.();
    await waitFor(() => pulls >= 2, "the hung pull");
    const controller = new AbortController();
    const schemeRead = call.getBody?.(controller.signal);
    controller.abort();

    expect(await outcome(schemeRead, 400)).toBe("rejected");
    expect(await outcome(hookRead, 400)).toBe("rejected");
  });

  it("never resolves partial bytes when consumers sharing a signal abort mid-read", async () => {
    for (let round = 0; round < 20; round++) {
      let pulls = 0;
      const stream = hangingStream(() => (pulls += 1));
      const request = new Request("https://pay.example/shared-signal", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit);
      const call = httpPaymentCall(request, () => request);
      const controller = new AbortController();
      const first = call.getBody?.(controller.signal);
      const second = call.getBody?.(controller.signal);
      await waitFor(() => pulls >= 2, "the hung pull");
      controller.abort();

      expect(await outcome(first, 400)).toBe("rejected");
      expect(await outcome(second, 400)).toBe("rejected");
    }
  });

  it("rejects instead of returning partial bytes when the source ends itself on abort", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let reads = 0;
    let endPending: (() => void) | undefined;
    // A source that closes its own stream when the signal aborts, before any
    // listener the reader adds later runs: the pending read resolves `done`.
    controller.signal.addEventListener("abort", () => endPending?.());
    const reader = {
      read: () => {
        reads += 1;
        if (reads === 1) return Promise.resolve({ done: false, value: encoder.encode("partial") });
        return new Promise(resolve => {
          endPending = () => resolve({ done: true, value: undefined });
        });
      },
      cancel: () => Promise.resolve(),
    };
    const source = { bodyUsed: false, body: { getReader: () => reader } } as unknown as Request;
    const request = new Request("https://pay.example/self-ending", {
      method: "POST",
      body: "x",
      signal: controller.signal,
    });
    const call = httpPaymentCall(request, () => source);
    const pending = call.getBody?.();
    await waitFor(() => reads >= 2, "the pending read");
    controller.abort();

    expect(await outcome(pending, 400)).toBe("rejected");
  });

  it("keeps completed bytes when a later consumer's signal is already aborted", async () => {
    const request = new Request("https://pay.example/cached", { method: "POST", body: "abc" });
    const call = httpPaymentCall(request, () => request.clone());
    expect(new TextDecoder().decode(await call.getBody?.())).toBe("abc");

    const controller = new AbortController();
    controller.abort();
    await expect(call.getBody?.(controller.signal)).rejects.toBeTruthy();
    expect(new TextDecoder().decode(await call.getBody?.())).toBe("abc");
  });
});

/**
 * A body stream that yields one chunk and then never produces another.
 *
 * @param onPull - Called on every pull
 * @returns The stream
 */
function hangingStream(onPull: () => number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      if (onPull() === 1) {
        controller.enqueue(new TextEncoder().encode("partial"));
        return;
      }
      return new Promise(() => undefined);
    },
  });
}

describe("wrapFetchWithPayment call context", () => {
  it("passes the original call to the first payment and to recovery", async () => {
    const seen: Array<{ url: string; signature?: string; body?: string }> = [];
    const scheme: SchemeNetworkClient = {
      scheme: "test-scheme",
      async createPaymentPayload(_version, _requirements, context) {
        if (context?.call?.kind !== "http") throw new Error("request_context_missing");
        const body = context.call.getBody
          ? new TextDecoder().decode(await context.call.getBody())
          : undefined;
        seen.push({
          url: context.call.url,
          signature: context.call.headers["payment-signature"],
          body,
        });
        return { x402Version: 2, payload: { signature: "scheme_signature" } };
      },
    };
    const client = new x402Client().register(network, scheme).setSpendControls(false);
    let recovered = false;
    client.onPaymentResponse(async () => {
      if (recovered) return;
      recovered = true;
      return { recovered: true };
    });
    let attempts = 0;
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      attempts += 1;
      bodies.push(await request.clone().text());
      if (attempts < 3) return paymentRequiredResponse();
      return new Response("ok", { status: 200 });
    });
    const paid = wrapFetchWithPayment(fetchMock, new x402HTTPClient(client));
    const response = await paid("https://pay.example/recover", {
      method: "POST",
      body: "payload-bytes",
      headers: { "X-Request-Id": "recover" },
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual([
      { url: "https://pay.example/recover", signature: undefined, body: "payload-bytes" },
      { url: "https://pay.example/recover", signature: undefined, body: "payload-bytes" },
    ]);
    expect(bodies).toEqual(["payload-bytes", "payload-bytes", "payload-bytes"]);
    const paidRequest = fetchMock.mock.calls[1][0] as Request;
    expect(paidRequest.headers.get("PAYMENT-SIGNATURE")).toBeTruthy();
    expect(paidRequest.headers.get("x-request-id")).toBe("recover");
  });

  it("keeps concurrent fetches on one client bound to their own urls", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let waiting = 0;
    const seen: string[] = [];
    const scheme: SchemeNetworkClient = {
      scheme: "test-scheme",
      async createPaymentPayload(_version, _requirements, context) {
        if (context?.call?.kind !== "http") throw new Error("request_context_missing");
        const url = context.call.url;
        waiting += 1;
        await gate;
        seen.push(url);
        return { x402Version: 2, payload: { signature: "scheme_signature" } };
      },
    };
    const client = new x402Client().register(network, scheme).setSpendControls(false);
    const paid = wrapFetchWithPayment(async request => {
      const current = request as Request;
      if (!current.headers.get("PAYMENT-SIGNATURE")) return paymentRequiredResponse();
      return new Response(current.url, { status: 200 });
    }, client);

    const first = paid("https://pay.example/a");
    const second = paid("https://pay.example/b");
    await waitFor(() => waiting === 2, "concurrent fetches");
    release();
    const results = await Promise.all([first, second]);
    expect(seen.sort()).toEqual(["https://pay.example/a", "https://pay.example/b"]);
    expect(await results[0].text()).toBe("https://pay.example/a");
    expect(await results[1].text()).toBe("https://pay.example/b");
  });

  it("fails closed instead of signing when the request is aborted", async () => {
    let signed = false;
    const scheme: SchemeNetworkClient = {
      scheme: "test-scheme",
      async createPaymentPayload(_version, _requirements, context) {
        if (context?.call?.kind !== "http" || !context.call.getBody) {
          throw new Error("request_context_missing");
        }
        await context.call.getBody();
        signed = true;
        return { x402Version: 2, payload: { signature: "scheme_signature" } };
      },
    };
    const client = new x402Client().register(network, scheme).setSpendControls(false);
    const controller = new AbortController();
    const paid = wrapFetchWithPayment(async () => paymentRequiredResponse(), client);
    const pending = paid("https://pay.example/abort", {
      method: "POST",
      body: "abc",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/Failed to create payment payload/);
    expect(signed).toBe(false);
  });

  it("aborts a body read in progress without hanging or signing", async () => {
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode("partial"));
          return;
        }
        return new Promise(() => undefined);
      },
    });
    let signed = false;
    const scheme: SchemeNetworkClient = {
      scheme: "test-scheme",
      async createPaymentPayload(_version, _requirements, context) {
        if (context?.call?.kind !== "http" || !context.call.getBody) {
          throw new Error("request_context_missing");
        }
        await context.call.getBody();
        signed = true;
        return { x402Version: 2, payload: { signature: "scheme_signature" } };
      },
    };
    const client = new x402Client().register(network, scheme).setSpendControls(false);
    const controller = new AbortController();
    const paid = wrapFetchWithPayment(async () => paymentRequiredResponse(), client);
    const pending = paid("https://pay.example/wrapper-abort", {
      method: "POST",
      body: stream,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit);
    await waitFor(() => pulls >= 2, "the wrapper read");
    controller.abort();
    expect(await outcome(pending, 400)).toBe("rejected");
    expect(signed).toBe(false);
  });

  it("does not clone the request for the body when no scheme reads it", async () => {
    const originalClone = Request.prototype.clone;
    let clones = 0;
    Request.prototype.clone = function cloneRequest(this: Request) {
      clones += 1;
      return originalClone.call(this);
    };
    try {
      const client = new x402Client()
        .register(network, {
          scheme: "test-scheme",
          createPaymentPayload: async () => ({
            x402Version: 2,
            payload: { signature: "scheme_signature" },
          }),
        })
        .setSpendControls(false);
      const paid = wrapFetchWithPayment(async request => {
        const current = request as Request;
        if (!current.headers.get("PAYMENT-SIGNATURE")) return paymentRequiredResponse();
        return new Response("ok", { status: 200 });
      }, client);
      const response = await paid("https://pay.example/unread", {
        method: "POST",
        body: "payload-bytes",
      });
      expect(response.status).toBe(200);
      // The wrapper's own clones (the copy kept for the paid retry, and the one
      // it sends); none extra for the unread body.
      expect(clones).toBe(2);
    } finally {
      Request.prototype.clone = originalClone;
    }
  });
});
