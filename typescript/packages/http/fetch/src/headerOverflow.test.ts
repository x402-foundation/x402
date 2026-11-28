import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "./index";

describe("Fetch response-header overflow diagnostics", () => {
  const requirements = {
    scheme: "exact",
    network: "test:fixture" as const,
    amount: "1",
    asset: "fixture-asset",
    payTo: "fixture-recipient",
    maxTimeoutSeconds: 60,
    extra: {},
  };
  const challenge = {
    x402Version: 2,
    resource: { url: "http://localhost/paid" },
    accepts: [requirements],
  };
  let server: Server;
  let url: string;
  let requests: number;
  let client: x402Client;
  const createPayload = vi.fn(async (x402Version: number) => ({
    x402Version,
    payload: { fixture: true },
  }));

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests++;
      if (request.url === "/large-other") {
        response.setHeader("X-Large", "x".repeat(32 * 1024));
      } else if (request.url === "/large-payment") {
        response.writeHead(402, {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
            ...challenge,
            extensions: { bazaar: { info: { example: "x".repeat(32 * 1024) } } },
          }),
        });
      } else if (!request.headers["payment-signature"]) {
        response.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(challenge) });
      }
      response.end("resource");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    url = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });

  beforeEach(() => {
    requests = 0;
    createPayload.mockClear();
    client = new x402Client()
      .register(requirements.network, {
        scheme: "exact",
        createPaymentPayload: createPayload,
      })
      .setSpendControls(false);
  });

  it.each(["/large-payment", "/large-other"])(
    "explains a real overflow at %s before payment",
    async path => {
      const wrapped = wrapFetchWithPayment(fetch, client);
      const error = await wrapped(url + path).catch((error: Error) => error);

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message: expect.stringContaining("Response headers exceed"),
        cause: { cause: { code: "UND_ERR_HEADERS_OVERFLOW" } },
      });
      expect((error as Error).message).toContain("PAYMENT-REQUIRED");
      expect((error as Error).message).toContain("may be responsible");
      expect(requests).toBe(1);
      expect(createPayload).not.toHaveBeenCalled();
    },
  );

  it("still handles an ordinary challenge and payment retry", async () => {
    const response = await wrapFetchWithPayment(fetch, client)(url + "/paid");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("resource");
    expect(requests).toBe(2);
    expect(createPayload).toHaveBeenCalledTimes(1);
  });

  it("preserves an unrelated transport error unchanged", async () => {
    const failure = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const transport = vi.fn().mockRejectedValue(failure);

    await expect(wrapFetchWithPayment(transport, client)(url)).rejects.toBe(failure);
    expect(createPayload).not.toHaveBeenCalled();
  });

  it.each(["auth", "paid", "recovery"])("diagnoses overflow during the %s retry", async phase => {
    const failure = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UND_ERR_HEADERS_OVERFLOW" },
    });
    const challengeResponse = () =>
      new Response("", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(challenge) },
      });
    const httpClient = new x402HTTPClient(client);
    if (phase === "auth") {
      httpClient.onPaymentRequired(async () => ({ headers: { Authorization: "fixture" } }));
    }
    if (phase === "recovery") {
      client.onPaymentResponse(async () => ({ recovered: true }));
    }
    const transport = vi.fn().mockResolvedValueOnce(challengeResponse());
    if (phase === "recovery") transport.mockResolvedValueOnce(challengeResponse());
    transport.mockRejectedValue(failure);

    await expect(wrapFetchWithPayment(transport, httpClient)(url)).rejects.toMatchObject({
      message: expect.stringContaining("Response headers exceed"),
      cause: failure,
    });
    expect(transport).toHaveBeenCalledTimes(phase === "recovery" ? 3 : 2);
    expect(createPayload).toHaveBeenCalledTimes(phase === "auth" ? 0 : phase === "paid" ? 1 : 2);
  });
});
