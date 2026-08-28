import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "./index";

/**
 * Issue a single HTTP GET to the given port + raw path and return the
 * response status. The path is sent verbatim — Node does not re-encode
 * it — which is exactly what an attacker on the wire could do.
 *
 * @param port - The local server port.
 * @param rawPath - The raw HTTP path (already percent-encoded as desired).
 * @returns The response status code.
 */
async function statusFor(port: number, rawPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: rawPath }, res => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Reproduces CAT finding f2e83cec-d5d5-4076-bd4e-55e060d216b1: a wildcard
 * route pattern (`"/api/premium/*"`) is compiled to a regex using `.*?`
 * without the dotAll ('s') flag. `normalizePath()` runs the raw request
 * path through `decodeURIComponent`, so a percent-encoded ECMAScript line
 * terminator (e.g. %E2%80%A8 -> U+2028) decodes into a literal character
 * that the `.` atom cannot match without dotAll, causing the route regex
 * to fail to match and `requiresPayment()` to return false.
 */
describe("express end-to-end: percent-encoded line terminator under wildcard route", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    const resourceServer = new x402ResourceServer();
    app.use(
      paymentMiddleware(
        {
          "/api/premium/*": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00",
              network: "eip155:84532",
            },
          },
        },
        resourceServer,
        undefined,
        undefined,
        // syncFacilitatorOnStart=false so the test does not try to call a real facilitator
        false,
      ),
    );
    // Catch-all so a skipped route is 200, distinct from a framework 404.
    app.use((_req, res) => res.status(200).send("ok"));

    server = app.listen(0);
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("returns 402 for a baseline wildcard match", async () => {
    expect(await statusFor(port, "/api/premium/report")).toBe(402);
  });

  it("returns 402 even when the tail contains %E2%80%A8 (U+2028 LINE SEPARATOR)", async () => {
    expect(await statusFor(port, "/api/premium/report%E2%80%A8")).toBe(402);
  });

  it("returns 402 even when the tail contains %E2%80%A9 (U+2029 PARAGRAPH SEPARATOR)", async () => {
    expect(await statusFor(port, "/api/premium/report%E2%80%A9")).toBe(402);
  });

  it("returns 402 even when the tail contains %0A (encoded LF)", async () => {
    expect(await statusFor(port, "/api/premium/report%0A")).toBe(402);
  });

  it("returns 402 even when the tail contains %0D (encoded CR)", async () => {
    expect(await statusFor(port, "/api/premium/report%0D")).toBe(402);
  });

  it("returns 200 (middleware skipped) for an unrelated path", async () => {
    expect(await statusFor(port, "/health")).toBe(200);
  });
});
