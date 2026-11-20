import {
  Agent,
  createServer,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { type AddressInfo } from "node:net";
import { type Readable } from "node:stream";
import axios, { type AxiosInstance } from "axios";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { wrapAxiosWithPayment, x402Client, x402HTTPClient } from "./index";

describe("streamed payment responses", () => {
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
  let agent: Agent;
  let server: Server;
  let origin: string;
  let api: AxiosInstance;
  let client: x402Client;
  let httpClient: x402HTTPClient;
  let respond: RequestListener;
  let requests: string[];

  const challenge = (res: ServerResponse, body = "{}") => {
    res.writeHead(402, {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
        x402Version: 2,
        resource: { url: origin + "/paid" },
        accepts: [requirements],
      }),
    });
    res.end(body);
  };

  beforeEach(async () => {
    requests = [];
    client = new x402Client()
      .register(network, {
        scheme: "exact",
        createPaymentPayload: async x402Version => ({
          x402Version,
          payload: { fixture: true },
        }),
      })
      .setSpendControls({
        allowedAssets: [{ network, asset: requirements.asset, maxAmountPerPayment: "1" }],
      });
    httpClient = new x402HTTPClient(client);
    respond = (req, res) => {
      if (req.headers["payment-signature"]) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("paid resource");
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
    server.keepAliveTimeout = 30_000;
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    agent = new Agent({ keepAlive: true, maxSockets: 1 });
    api = wrapAxiosWithPayment(
      axios.create({ proxy: false, httpAgent: agent, responseType: "stream" }),
      httpClient,
    );
  });

  afterEach(async () => {
    agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });

  const readBody = async (body: Readable): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString();
  };

  it("releases the initial 402 so a one-socket agent can send the payment", async () => {
    const response = await api.get<Readable>(origin + "/paid", {
      signal: AbortSignal.timeout(2_000),
    });

    expect(response.status).toBe(200);
    expect(await readBody(response.data)).toBe("paid resource");
    expect(requests).toEqual(["unpaid", "paid"]);
  });

  it("releases a rejected alternate-auth response before falling back to payment", async () => {
    httpClient.onPaymentRequired(async () => ({ headers: { Authorization: "Bearer fixture" } }));

    const response = await api.get<Readable>(origin + "/paid", {
      signal: AbortSignal.timeout(2_000),
    });

    expect(await readBody(response.data)).toBe("paid resource");
    expect(requests).toEqual(["unpaid", "auth", "paid"]);
  });

  it("releases the paid response before the single recovery retry", async () => {
    let paidRequests = 0;
    const originalRespond = respond;
    respond = (req, res) => {
      if (req.headers["payment-signature"] && ++paidRequests === 1) {
        challenge(res);
      } else {
        originalRespond(req, res);
      }
    };
    client.onPaymentResponse(async context => {
      if (context.paymentRequired) return { recovered: true };
    });

    const response = await api.get<Readable>(origin + "/paid", {
      signal: AbortSignal.timeout(2_000),
    });

    expect(response.status).toBe(200);
    expect(await readBody(response.data)).toBe("paid resource");
    expect(requests).toEqual(["unpaid", "paid", "paid"]);
  });

  it.each([false, true])(
    "leaves a terminal 402 readable (recovery requested: %s)",
    async recover => {
      respond = (_req, res) => challenge(res, '{"error":"payment declined"}');
      if (recover) client.onPaymentResponse(async () => ({ recovered: true }));

      const response = await api.get<Readable>(origin + "/paid", {
        signal: AbortSignal.timeout(2_000),
      });

      expect(response.status).toBe(402);
      expect(response.data.destroyed).toBe(false);
      expect(await readBody(response.data)).toBe('{"error":"payment declined"}');
      expect(requests).toEqual(recover ? ["unpaid", "paid", "paid"] : ["unpaid", "paid"]);
    },
  );

  it("returns the final paid stream before its body ends", async () => {
    const originalRespond = respond;
    let finishBody: (() => void) | undefined;
    respond = (req, res) => {
      if (req.headers["payment-signature"]) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("paid ");
        finishBody = () => res.end("resource");
      } else {
        originalRespond(req, res);
      }
    };

    const response = await api.get<Readable>(origin + "/paid", {
      signal: AbortSignal.timeout(2_000),
    });

    expect(response.data.destroyed).toBe(false);
    expect(response.data.readableEnded).toBe(false);
    expect(finishBody).toBeTypeOf("function");
    finishBody!();
    expect(await readBody(response.data)).toBe("paid resource");
  });

  it("does not exhaust the agent across sequential payments", async () => {
    for (let i = 0; i < 3; i++) {
      const response = await api.get<Readable>(origin + "/paid", {
        signal: AbortSignal.timeout(2_000),
      });
      expect(await readBody(response.data)).toBe("paid resource");
    }
    expect(requests).toEqual(["unpaid", "paid", "unpaid", "paid", "unpaid", "paid"]);
  });

  it("leaves a successful alternate-auth stream readable without paying", async () => {
    const originalRespond = respond;
    httpClient.onPaymentRequired(async () => ({ headers: { Authorization: "Bearer fixture" } }));
    respond = (req, res) => {
      if (req.headers.authorization) res.end("authenticated resource");
      else originalRespond(req, res);
    };

    const response = await api.get<Readable>(origin + "/paid", {
      signal: AbortSignal.timeout(2_000),
    });
    expect(response.data.destroyed).toBe(false);
    expect(await readBody(response.data)).toBe("authenticated resource");
    expect(requests).toEqual(["unpaid", "auth"]);
  });

  it("preserves buffered response handling", async () => {
    const response = await api.get<string>(origin + "/paid", {
      responseType: "text",
      signal: AbortSignal.timeout(2_000),
    });
    expect(response.status).toBe(200);
    expect(response.data).toBe("paid resource");
    expect(requests).toEqual(["unpaid", "paid"]);
  });

  it("does not wait for an intermediate body to finish before retrying", async () => {
    const originalRespond = respond;
    respond = (req, res) => {
      if (req.headers["payment-signature"]) originalRespond(req, res);
      else {
        res.writeHead(402, {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
            x402Version: 2,
            resource: { url: origin + "/paid" },
            accepts: [requirements],
          }),
        });
        res.write("unfinished body");
      }
    };

    const response = await api.get<Readable>(origin + "/paid", {
      signal: AbortSignal.timeout(2_000),
    });
    expect(await readBody(response.data)).toBe("paid resource");
    expect(requests).toEqual(["unpaid", "paid"]);
  });

  it.each([1, 2])("releases a hidden response if payment response hook %i throws", async failAt => {
    const originalRespond = respond;
    respond = (req, res) => {
      if (req.url === "/free") res.end("free resource");
      else originalRespond(req, res);
    };
    let calls = 0;
    client.onPaymentResponse(async () => {
      if (++calls === failAt) throw new Error("fixture hook failure");
      return { recovered: true };
    });

    const controller = new AbortController();
    try {
      await expect(api.get(origin + "/paid", { signal: controller.signal })).rejects.toThrow(
        "fixture hook failure",
      );
      const response = await api.get<Readable>(origin + "/free", {
        signal: AbortSignal.timeout(2_000),
      });
      expect(await readBody(response.data)).toBe("free resource");
      expect(calls).toBe(failAt);
    } finally {
      controller.abort();
    }
  });
});
