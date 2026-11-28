import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import axios, { type AxiosRequestConfig } from "axios";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { wrapAxiosWithPayment, x402Client, x402HTTPClient } from "./index";

describe("payment handling with custom status validation", () => {
  const network = "test:fixture";
  const requirements = {
    scheme: "exact",
    network,
    amount: "1",
    asset: "fixture-asset",
    payTo: "fixture-recipient",
    maxTimeoutSeconds: 60,
    extra: {},
  } as const;
  let server: Server;
  let origin: string;
  let client: x402Client;
  let httpClient: x402HTTPClient;
  let payloads: number;
  let requests: string[];
  let respond: RequestListener;

  const challenge = (res: ServerResponse) => {
    res.writeHead(402, {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
        x402Version: 2,
        resource: { url: origin + "/paid" },
        accepts: [requirements],
      }),
    });
    res.end('{"error":"Payment Required"}');
  };

  const makeApi = (config: AxiosRequestConfig = {}) =>
    wrapAxiosWithPayment(axios.create({ proxy: false, timeout: 2_000, ...config }), httpClient);

  beforeEach(async () => {
    payloads = 0;
    requests = [];
    client = new x402Client()
      .register(network, {
        scheme: "exact",
        createPaymentPayload: async x402Version => {
          if (++payloads > 3) throw new Error("Unexpected extra payment attempt");
          return { x402Version, payload: { fixture: true } };
        },
      })
      .setSpendControls({
        allowedAssets: [{ network, asset: requirements.asset, maxAmountPerPayment: "1" }],
      });
    httpClient = new x402HTTPClient(client);
    respond = (req, res) => {
      if (req.headers["payment-signature"]) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"resource":"paid"}');
      } else {
        challenge(res);
      }
    };
    server = createServer((req, res) => {
      requests.push(
        req.headers["payment-signature"] ? "paid" : req.headers.authorization ? "auth" : "unpaid",
      );
      respond(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });

  it("pays an initial 402 accepted by the instance validator", async () => {
    const response = await makeApi({ validateStatus: status => status < 500 }).get(
      origin + "/paid",
    );

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ resource: "paid" });
    expect(requests).toEqual(["unpaid", "paid"]);
    expect(payloads).toBe(1);
  });

  it.each([
    { name: "per-request function", validateStatus: (status: number) => status < 500 },
    { name: "null", validateStatus: null },
    { name: "undefined", validateStatus: undefined },
  ])("pays with a $name request validator", async ({ validateStatus }) => {
    const response = await makeApi().get(origin + "/paid", { validateStatus });
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ resource: "paid" });
    expect(requests).toEqual(["unpaid", "paid"]);
    expect(payloads).toBe(1);
  });

  it("falls back from alternate auth to one paid retry without re-entering the hooks", async () => {
    let authAttempts = 0;
    httpClient.onPaymentRequired(async () => {
      if (++authAttempts > 1) throw new Error("Unexpected repeated auth attempt");
      return { headers: { Authorization: "Bearer fixture" } };
    });

    const response = await makeApi({ validateStatus: status => status < 500 }).get(
      origin + "/paid",
    );
    expect(response.data).toEqual({ resource: "paid" });
    expect(requests).toEqual(["unpaid", "auth", "paid"]);
    expect(authAttempts).toBe(1);
    expect(payloads).toBe(1);
  });

  it.each([null, undefined])(
    "preserves accept-all semantics on a paid 500 (%s)",
    async validateStatus => {
      const originalRespond = respond;
      respond = (req, res) => {
        if (req.headers["payment-signature"]) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end('{"error":"resource failure"}');
        } else originalRespond(req, res);
      };

      const response = await makeApi({ validateStatus }).get(origin + "/paid");
      expect(response.status).toBe(500);
      expect(response.data).toEqual({ error: "resource failure" });
      expect(requests).toEqual(["unpaid", "paid"]);
      expect(payloads).toBe(1);
    },
  );

  it.each([undefined, "not-a-payment-header"])(
    "does not pay an accepted non-x402 402 (%s)",
    async header => {
      respond = (_req, res) => {
        res.writeHead(402, {
          "Content-Type": "application/json",
          ...(header ? { "PAYMENT-REQUIRED": header } : {}),
        });
        res.end('{"error":"ordinary 402"}');
      };
      const response = await makeApi({ validateStatus: status => status < 500 }).get(
        origin + "/paid",
      );
      expect(response.status).toBe(402);
      expect(response.data).toEqual({ error: "ordinary 402" });
      expect(requests).toEqual(["unpaid"]);
      expect(payloads).toBe(0);
    },
  );

  it.each([false, true])("keeps corrective 402 retries bounded (recovery: %s)", async recover => {
    respond = (_req, res) => challenge(res);
    let responses = 0;
    client.onPaymentResponse(async () => {
      responses++;
      if (recover) return { recovered: true };
    });

    const response = await makeApi({ validateStatus: status => status < 500 }).get(
      origin + "/paid",
    );
    expect(response.status).toBe(402);
    expect(response.data).toEqual({ error: "Payment Required" });
    expect(requests).toEqual(recover ? ["unpaid", "paid", "paid"] : ["unpaid", "paid"]);
    expect(payloads).toBe(recover ? 2 : 1);
    expect(responses).toBe(recover ? 2 : 1);
  });

  it.each([200, 409, 500])("preserves a caller predicate on the final %i", async status => {
    const originalRespond = respond;
    respond = (req, res) => {
      if (req.headers["payment-signature"]) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end('{"resource":"final"}');
      } else originalRespond(req, res);
    };
    const api = makeApi({ validateStatus: code => code === 402 || code === 409 });
    const request = api.get(origin + "/paid");
    if (status === 409) {
      const response = await request;
      expect(response.status).toBe(409);
      expect(response.data).toEqual({ resource: "final" });
    } else {
      await expect(request).rejects.toMatchObject({
        response: { status, data: { resource: "final" } },
      });
    }
    expect(requests).toEqual(["unpaid", "paid"]);
    expect(payloads).toBe(1);
  });

  it.each([200, 404, 500])("does not pay an ordinary %i response", async status => {
    respond = (_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end('{"resource":"ordinary"}');
    };
    const request = makeApi({ validateStatus: code => code < 500 }).get(origin + "/ordinary");
    if (status < 500) {
      const response = await request;
      expect(response.status).toBe(status);
      expect(response.data).toEqual({ resource: "ordinary" });
    } else await expect(request).rejects.toMatchObject({ response: { status: 500 } });
    expect(requests).toEqual(["unpaid"]);
    expect(payloads).toBe(0);
  });

  it("handles an accepted 402 through Axios's fetch adapter", async () => {
    const response = await makeApi({
      adapter: "fetch",
      validateStatus: status => status < 500,
    }).get(origin + "/paid");
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ resource: "paid" });
    expect(requests).toEqual(["unpaid", "paid"]);
    expect(payloads).toBe(1);
  });

  it.each([
    { name: "default", config: {} },
    {
      name: "excludes 402",
      config: { validateStatus: (status: number) => status < 500 && status !== 402 },
    },
  ])("preserves payment handling when the validator $name", async ({ config }) => {
    const response = await makeApi(config).get(origin + "/paid");
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ resource: "paid" });
    expect(requests).toEqual(["unpaid", "paid"]);
    expect(payloads).toBe(1);
  });
});
