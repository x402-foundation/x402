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

describe("express end-to-end: encoded path separator", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    const resourceServer = new x402ResourceServer();
    app.use(
      paymentMiddleware(
        {
          "/api/report/:id": {
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
    // Catch-all so an unprotected route returns 200, not 404, letting us
    // tell "middleware skipped the route" apart from "framework 404".
    app.use((_req, res) => res.status(200).send("ok"));

    server = app.listen(0);
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("returns 402 for a baseline single-segment :id", async () => {
    expect(await statusFor(port, "/api/report/baseline")).toBe(402);
  });

  it("returns 402 even when the :id segment contains %2F (uppercase)", async () => {
    expect(await statusFor(port, "/api/report/a%2Fb")).toBe(402);
  });

  it("returns 402 even when the :id segment contains %2f (lowercase)", async () => {
    expect(await statusFor(port, "/api/report/a%2fb")).toBe(402);
  });

  it("returns 402 even when the :id segment contains %5C (encoded backslash)", async () => {
    expect(await statusFor(port, "/api/report/a%5Cb")).toBe(402);
  });

  // path-to-regexp still dispatches /api/report/a\b to the :id handler, so
  // folding that "\" into a "/" in the middleware would fail open.
  it("returns 402 even when the :id segment contains a raw backslash", async () => {
    expect(await statusFor(port, "/api/report/a\\b")).toBe(402);
  });

  it("returns 200 (middleware skipped) for an unrelated path", async () => {
    expect(await statusFor(port, "/health")).toBe(200);
  });
});

describe("express end-to-end: trailing wildcard route prefix", () => {
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
        false,
      ),
    );
    app.use((_req, res) => res.status(200).send("ok"));

    server = app.listen(0);
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("returns 402 for a baseline wildcard sub-path", async () => {
    expect(await statusFor(port, "/api/premium/report")).toBe(402);
  });

  it("returns 402 for the bare wildcard prefix with a trailing slash", async () => {
    expect(await statusFor(port, "/api/premium/")).toBe(402);
  });

  it("returns 402 for the bare wildcard prefix without a trailing slash", async () => {
    expect(await statusFor(port, "/api/premium")).toBe(402);
  });

  it("returns 200 (middleware skipped) for an unrelated path", async () => {
    expect(await statusFor(port, "/health")).toBe(200);
  });
});
