import { createServer } from "node:http";
import axios from "axios";
import { describe, expect, it } from "vitest";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { wrapAxiosWithPayment, x402Client, x402HTTPClient } from "./index";

describe.each(["http", "fetch"] as const)("Axios %s header suppression", adapter => {
  it.each([false, null])("preserves %s across the header retry", async sentinel => {
    const seen: {
      disabled: string | string[] | undefined;
      trace: string | string[] | undefined;
    }[] = [];
    const challenge = encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: "http://fixture.test/resource" },
      accepts: [],
    });
    const server = createServer((request, response) => {
      seen.push({ disabled: request.headers["x-disabled"], trace: request.headers["x-trace"] });
      if (request.url !== "/native" && request.headers["x-hook"] !== "retry") {
        response.writeHead(402, { "PAYMENT-REQUIRED": challenge });
      }
      response.end("ok");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const url = `http://127.0.0.1:${address.port}`;
    const instance = axios.create({
      adapter,
      proxy: false,
      headers: { "X-Disabled": "instance-default" },
    });
    const headers = { "X-Disabled": sentinel, "X-Trace": "keep-me" };

    try {
      await instance.get(url + "/native", { headers });
      const client = new x402HTTPClient(new x402Client()).onPaymentRequired(async () => ({
        headers: { "X-Hook": "retry" },
      }));
      const response = await wrapAxiosWithPayment(instance, client).get(url + "/wrapped", {
        headers,
      });

      expect(response.status).toBe(200);
      expect(seen).toEqual([
        { disabled: undefined, trace: "keep-me" },
        { disabled: undefined, trace: "keep-me" },
        { disabled: undefined, trace: "keep-me" },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    }
  });
});
