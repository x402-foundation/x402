import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { encodePaymentRequiredHeader, ResponseBodyTooLargeError } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client } from "./index";

const requirements = {
  scheme: "exact",
  network: "test:fixture" as const,
  amount: "1",
  asset: "fixture-asset",
  payTo: "fixture-recipient",
  maxTimeoutSeconds: 60,
  extra: {},
};
const challenge = encodePaymentRequiredHeader({
  x402Version: 2,
  resource: { url: "http://fixture.test/resource" },
  accepts: [requirements],
});

/**
 * Builds a fixture protocol client without signing.
 *
 * @returns Client using a local payload fixture
 */
function makeClient() {
  return new x402Client()
    .register(requirements.network, {
      scheme: "exact",
      createPaymentPayload: async x402Version => ({ x402Version, payload: { fixture: true } }),
    })
    .setSpendControls(false);
}

/**
 * Creates the challenge that precedes the terminal response.
 *
 * @returns Initial 402 response
 */
function initialResponse() {
  return new Response("", { status: 402, headers: { "PAYMENT-REQUIRED": challenge } });
}

describe("returned 402 Response preservation", () => {
  it.each([false, true])("retains native metadata after recovery=%s", async recovery => {
    const bytes = new Uint8Array([0, 255, 195, 40, 97]);
    let paidRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === "/terminal") {
        response.writeHead(402, { "Content-Length": bytes.byteLength, "X-Trace": "terminal" });
        response.end(bytes);
      } else if (!request.headers["payment-signature"] || (recovery && ++paidRequests === 1)) {
        response.writeHead(402, { "PAYMENT-REQUIRED": challenge });
        response.end("");
      } else {
        response.writeHead(302, { Location: "/terminal" });
        response.end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const url = `http://127.0.0.1:${address.port}`;
    const client = makeClient();
    if (recovery) client.onPaymentResponse(async () => ({ recovered: true }));
    let terminal: Response | undefined;
    const transport: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (response.url.endsWith("/terminal")) terminal = response;
      return response;
    };

    try {
      const response = await wrapFetchWithPayment(transport, client)(url + "/challenge");

      expect(response).toBe(terminal);
      expect(response.url).toBe(url + "/terminal");
      expect(response.redirected).toBe(true);
      expect(response.type).toBe("basic");
      expect(response.headers.get("X-Trace")).toBe("terminal");
      expect(response.bodyUsed).toBe(false);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    }
  });

  it("returns a bodyless 402 unchanged", async () => {
    const terminal = new Response(null, { status: 402 });
    let requests = 0;
    const transport: typeof fetch = async () => (++requests === 1 ? initialResponse() : terminal);

    const response = await wrapFetchWithPayment(transport, makeClient())("https://fixture.test/");

    expect(response).toBe(terminal);
    expect(response.body).toBeNull();
    expect(response.bodyUsed).toBe(false);
  });

  it("cancels both branches on overflow instead of waiting on one tee branch", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const terminal = new Response(stream, { status: 402 });
    let requests = 0;
    const transport: typeof fetch = async () => (++requests === 1 ? initialResponse() : terminal);

    await expect(
      wrapFetchWithPayment(transport, makeClient())("https://fixture.test/"),
    ).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(cancelled).toBe(true);
  });

  it("preserves an inspection read error", async () => {
    const failure = new Error("fixture body read failed");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    const terminal = new Response(stream, { status: 402 });
    let requests = 0;
    const transport: typeof fetch = async () => (++requests === 1 ? initialResponse() : terminal);

    await expect(
      wrapFetchWithPayment(transport, makeClient())("https://fixture.test/"),
    ).rejects.toBe(failure);
  });
});
