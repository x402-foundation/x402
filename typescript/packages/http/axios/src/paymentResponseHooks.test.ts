import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import axios, { AxiosError } from "axios";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, SchemeNetworkClient, SettleResponse } from "@x402/core/types";
import { wrapAxiosWithPayment, x402Client, type PaymentPayload } from "./index";

const network = "eip155:84532" as const;

const settleResponse: SettleResponse = {
  success: true,
  transaction: "0xsettled",
  network,
};

const scheme: SchemeNetworkClient = {
  scheme: "exact",
  createPaymentPayload: async x402Version => ({
    x402Version,
    payload: { signature: "0xmocksignature" },
  }),
};

describe("payment response hooks on paid HTTP errors", () => {
  let origin: string;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!req.headers["payment-signature"]) {
      const paymentRequired: PaymentRequired = {
        x402Version: 2,
        resource: { url: `${origin}${url.pathname}` },
        accepts: [
          {
            scheme: "exact",
            network,
            amount: "1",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            payTo: "0x1234567890123456789012345678901234567890",
            maxTimeoutSeconds: 60,
            extra: {},
          },
        ],
      };
      res.writeHead(402, { "payment-required": encodePaymentRequiredHeader(paymentRequired) });
      res.end();
      return;
    }
    res.writeHead(Number(url.searchParams.get("status")), {
      "payment-response": encodePaymentResponseHeader(settleResponse),
    });
    res.end();
  });

  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });

  it.each([200, 400, 500])("fires onPaymentResponse once for a paid %i response", async status => {
    const seen: Array<{ payload: PaymentPayload; settle?: SettleResponse }> = [];
    // The test asset is not a registered default asset, so opt out of spend controls.
    const client = x402Client
      .fromConfig({ schemes: [{ network, client: scheme }], spendControls: false })
      .onPaymentResponse(async ctx => {
        seen.push({ payload: ctx.paymentPayload, settle: ctx.settleResponse });
      });
    const api = wrapAxiosWithPayment(axios.create({ proxy: false }), client);

    const request = api.get(`${origin}/paid?status=${status}`);
    if (status < 300) {
      expect((await request).status).toBe(status);
    } else {
      const error = await request.then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
      expect(error).toBeInstanceOf(AxiosError);
      expect((error as AxiosError).response?.status).toBe(status);
    }

    expect(seen).toHaveLength(1);
    expect(seen[0].settle).toEqual(settleResponse);
    expect(seen[0].payload.payload).toEqual({ signature: "0xmocksignature" });
  });
});
