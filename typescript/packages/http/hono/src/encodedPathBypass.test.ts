import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "./index";

/**
 * Hono's `c.req.path` comes from `getPath()`, which runs `decodeURI()` before
 * the router matches, so an encoded backslash reaches the middleware as a raw
 * `\` while the router still dispatches `/api/report/a%5Cb` to `:id`.
 *
 * `app.request()` drives the full fetch handler without a real socket.
 *
 * @returns A Hono app with a paid `:id` route and a catch-all, so a skipped
 * paywall is observable as the paid body rather than a framework 404.
 */
function buildApp() {
  const app = new Hono();
  const resourceServer = new x402ResourceServer();
  app.use(
    "*",
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
      // syncFacilitatorOnStart=false so the test does not call a real facilitator
      false,
    ),
  );
  app.get("/api/report/:id", c => c.text("PAID_CONTENT", 200));
  app.all("*", c => c.text("unrouted", 404));
  return app;
}

describe("hono end-to-end: encoded path separator in a :param segment", () => {
  it("returns 402 for a baseline single-segment :id", async () => {
    const res = await buildApp().request("/api/report/baseline");
    expect(res.status).toBe(402);
  });

  it.each([
    ["encoded slash %2F", "/api/report/a%2Fb"],
    ["encoded slash %2f (lowercase)", "/api/report/a%2fb"],
    ["encoded backslash %5C", "/api/report/a%5Cb"],
    ["encoded backslash %5c (lowercase)", "/api/report/a%5cb"],
  ])("returns 402, not the paid body, for %s", async (_, path) => {
    const res = await buildApp().request(path);

    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain("PAID_CONTENT");
  });

  // Guards the test above from going vacuous: if Hono ever starts 404ing on
  // %5C, the 402 assertion would pass for the wrong reason.
  it("confirms Hono's router does dispatch an encoded backslash to the :id route", async () => {
    const app = new Hono();
    app.get("/api/report/:id", c => c.text("routed", 200));
    app.all("*", c => c.text("unrouted", 404));

    const res = await app.request("/api/report/a%5Cb");

    expect(res.status).toBe(200);
  });
});
