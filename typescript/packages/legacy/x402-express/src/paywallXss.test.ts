import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import { paymentMiddleware } from "./index";

// Exercise the source generator without depending on a previously built package.
vi.mock("x402/paywall", async () => import("../../x402/src/paywall"));
vi.mock("../../x402/src/paywall/gen/template", () => ({
  PAYWALL_TEMPLATE: "<!DOCTYPE html><html><head></head><body></body></html>",
}));
vi.mock("x402/verify", () => ({
  useFacilitator: () => ({ verify: vi.fn(), settle: vi.fn(), supported: vi.fn() }),
}));

describe("legacy Express paywall keeps request URLs inside script data", () => {
  let server: Server;
  let port: number;
  const payload = "</script><script>window.__x402Injected=true</script>";

  beforeAll(async () => {
    const app = express();
    app.use(
      paymentMiddleware("0x1111111111111111111111111111111111111111", {
        "/premium/*": { price: "$0.10", network: "base-sepolia" },
      }),
    );
    server = app.listen(0);
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it.each([
    { name: "normal request", path: "/premium/content", host: "example.test" },
    { name: "URL path", path: `/premium/content${payload}`, host: "example.test" },
    { name: "query string", path: `/premium/content?test=${payload}`, host: "example.test" },
    { name: "Host header", path: "/premium/content", host: `example.test${payload}` },
  ])("safely embeds request data from $name", async ({ path, host }) => {
    const response = await new Promise<{
      statusCode: number | undefined;
      headers: http.IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path,
          headers: { Host: host, Accept: "text/html", "User-Agent": "Mozilla/5.0" },
        },
        res => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      request.on("error", reject);
      request.end();
    });

    expect(response.statusCode).toBe(402);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("window.x402 =");

    // A closing tag inside a JS string still terminates the HTML script element.
    const scripts = [...response.body.matchAll(/<script>([\s\S]*?)<\/script\s*>/gi)];
    expect(scripts).toHaveLength(1);
    expect(response.body.match(/<\/script\s*>/gi)).toHaveLength(1);

    const context: {
      window: { x402?: { currentUrl: string; paymentRequirements: { resource: string }[] } };
    } = { window: {} };
    runInNewContext(scripts[0][1], context, { timeout: 1000 });

    expect(context.window.x402?.currentUrl).toBe(path);
    expect(context.window.x402?.paymentRequirements[0].resource).toBe(
      `http://${host}${path.split("?")[0]}`,
    );
  });
});
