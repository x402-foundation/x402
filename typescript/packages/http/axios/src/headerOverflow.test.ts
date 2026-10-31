import { createServer, type Server } from "node:http";
import axios, { AxiosError } from "axios";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { wrapAxiosWithPayment, x402Client } from "./index";

describe("Axios response-header overflow diagnostics", () => {
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
      } else if (
        request.url === "/large-payment" ||
        (request.headers["payment-signature"] && request.url === "/paid-overflow")
      ) {
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

  it.each(["/large-payment", "/large-other", "/paid-overflow"])(
    "preserves Axios error details at %s",
    async path => {
      const api = wrapAxiosWithPayment(axios.create({ proxy: false, timeout: 2000 }), client);
      const error = await api.get(url + path).catch((error: AxiosError) => error);

      expect(axios.isAxiosError(error)).toBe(true);
      expect(error).toBeInstanceOf(AxiosError);
      expect(error).toMatchObject({
        message: expect.stringContaining("Response headers exceed"),
        code: "HPE_HEADER_OVERFLOW",
        config: { url: url + path },
        cause: { code: "HPE_HEADER_OVERFLOW" },
      });
      expect((error as AxiosError).request).toBeDefined();
      expect((error as AxiosError).message).toContain("PAYMENT-REQUIRED");
      expect((error as AxiosError).message).toContain("may be responsible");
      expect(requests).toBe(path === "/paid-overflow" ? 2 : 1);
      expect(createPayload).toHaveBeenCalledTimes(path === "/paid-overflow" ? 1 : 0);
    },
  );

  it("still handles an ordinary challenge and payment retry", async () => {
    const api = wrapAxiosWithPayment(axios.create({ proxy: false }), client);
    const response = await api.get(url + "/paid");

    expect(response.status).toBe(200);
    expect(response.data).toBe("resource");
    expect(requests).toBe(2);
    expect(createPayload).toHaveBeenCalledTimes(1);
  });

  it("diagnoses overflow through Axios's fetch adapter", async () => {
    const api = wrapAxiosWithPayment(axios.create({ adapter: "fetch", timeout: 2000 }), client);
    const error = await api.get(url + "/large-payment").catch((error: AxiosError) => error);

    expect(axios.isAxiosError(error)).toBe(true);
    expect(error).toMatchObject({
      message: expect.stringContaining("Response headers exceed"),
      code: "ERR_NETWORK",
      config: { adapter: "fetch" },
    });
    let cause: unknown = (error as AxiosError).cause;
    while (cause instanceof Error && cause.cause) cause = cause.cause;
    expect(cause).toMatchObject({ code: "UND_ERR_HEADERS_OVERFLOW" });
    expect(requests).toBe(1);
    expect(createPayload).not.toHaveBeenCalled();
  });

  it("preserves an unrelated transport error unchanged", async () => {
    const failure = new AxiosError("connection reset", "ECONNRESET");
    const api = wrapAxiosWithPayment(
      axios.create({
        adapter: async () => {
          throw failure;
        },
      }),
      client,
    );

    await expect(api.get(url)).rejects.toBe(failure);
    expect(createPayload).not.toHaveBeenCalled();
  });
});
