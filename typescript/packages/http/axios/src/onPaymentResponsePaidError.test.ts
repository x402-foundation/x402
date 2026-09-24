import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import axios from "axios";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import { wrapAxiosWithPayment } from "./index";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

const requirements = {
  scheme: "exact" as const,
  network: "eip155:84532" as const,
  amount: "1",
  asset: "0x0000000000000000000000000000000000000001",
  payTo: "0x0000000000000000000000000000000000000002",
  maxTimeoutSeconds: 60,
  extra: {},
};

describe("onPaymentResponse for paid HTTP error responses", () => {
  let baseUrl: string;
  const server = createServer((req, res) => {
    req.resume();
    const paidStatus = Number(req.url?.slice(1));
    if (!req.headers["payment-signature"]) {
      const declaration = {
        x402Version: 2,
        resource: {
          url: `http://${req.headers.host}${req.url}`,
          description: "local test",
          mimeType: "application/json",
        },
        accepts: [requirements],
      };
      res.writeHead(402, { "PAYMENT-REQUIRED": encode(declaration) });
    } else {
      res.writeHead(paidStatus, {
        "PAYMENT-RESPONSE": encode({
          success: false,
          errorReason: "local_test_failure",
          network: requirements.network,
          transaction: "",
        }),
      });
    }
    res.end("{}");
  });

  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });

  it.each([200, 402, 400, 500])(
    "invokes onPaymentResponse for paid follow-up HTTP %i",
    async status => {
      const observed: Array<string | undefined> = [];
      const client = new x402Client().register(requirements.network, {
        scheme: "exact",
        createPaymentPayload: async x402Version => ({
          x402Version,
          payload: { testOnly: true },
        }),
      });
      client.setSpendControls({
        allowedAssets: [{ network: requirements.network, asset: requirements.asset, maxAmountPerPayment: "1" }],
      });
      client.onPaymentResponse(async ctx => {
        observed.push(ctx.settleResponse?.errorReason);
      });

      const api = wrapAxiosWithPayment(axios.create({ proxy: false }), client);
      let actualStatus: number | undefined;

      try {
        const response = await api.get(`${baseUrl}/${status}`);
        actualStatus = response.status;
      } catch (error) {
        if (axios.isAxiosError(error)) {
          actualStatus = error.response?.status;
        } else {
          throw error;
        }
      }

      expect(actualStatus).toBe(status);
      expect(observed).toEqual(["local_test_failure"]);
    },
  );
});
