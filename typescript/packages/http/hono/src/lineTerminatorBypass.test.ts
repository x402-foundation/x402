import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "./index";

/**
 * Checks CAT finding f2e83cec-d5d5-4076-bd4e-55e060d216b1 against the real
 * Hono request pipeline (not a hand-built mock Context).
 *
 * Unlike Express/Fastify (raw percent-encoded `req.path`/`request.url`) and
 * Next (`NextURL.pathname`, which also preserves percent-encoding), Hono's
 * `c.req.path` is produced by Hono's own `getPath()`, which runs
 * `decodeURI()` on the raw request URL *before Hono's router ever tries to
 * match a route*. A path that decodes to contain an ECMAScript
 * LineTerminator (LF, CR, U+2028, U+2029) fails Hono's own route matching —
 * verified below against a bare Hono app with the most permissive possible
 * route (`app.all("*")`, no x402 involved) — so Hono returns 404 and never
 * invokes ANY handler, paid or not, including the x402 payment middleware
 * itself. `requiresPayment()` is never called, so the core-level regex bug
 * that affects Express/Fastify/Next is unreachable through Hono: there is
 * no bypass to fix here, independent of whether `@x402/core`'s regex has
 * the dotAll flag.
 *
 * `app.request()` is Hono's documented way to drive the full fetch handler
 * (including its internal `getPath()` URL parsing) without a real socket —
 * `new Request(url)` preserves percent-encoding exactly as the wire would.
 */
describe("hono end-to-end: percent-encoded line terminator under wildcard route", () => {
  it.each([
    ["U+2028 LINE SEPARATOR", "/api/premium/report%E2%80%A8"],
    ["U+2029 PARAGRAPH SEPARATOR", "/api/premium/report%E2%80%A9"],
    ["LF", "/api/premium/report%0A"],
    ["CR", "/api/premium/report%0D"],
  ])("bare Hono router 404s on an encoded %s before any handler runs", async (_, path) => {
    const app = new Hono();
    let called = 0;
    app.use("*", async (_c, next) => {
      called++;
      await next();
    });
    app.all("*", c => c.text("ok", 200));

    const res = await app.request(path);

    expect(res.status).toBe(404);
    expect(called).toBe(0);
  });

  it("sanity check: the same bare app dispatches a normal path", async () => {
    const app = new Hono();
    app.all("*", c => c.text("ok", 200));

    const res = await app.request("/api/premium/report");

    expect(res.status).toBe(200);
  });

  describe("with the x402 payment middleware installed", () => {
    let requiresPaymentSpy: ReturnType<typeof vi.spyOn>;

    /**
     * Builds a Hono app with the x402 payment middleware installed on a
     * wildcard route, plus a catch-all so an unprotected path resolves to
     * 200 instead of a framework 404.
     *
     * @returns The configured Hono app.
     */
    function buildApp() {
      const app = new Hono();
      const resourceServer = new x402ResourceServer();
      app.use(
        "*",
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
      app.all("*", c => c.text("ok", 200));
      return app;
    }

    beforeEach(() => {
      requiresPaymentSpy = vi.spyOn(x402HTTPResourceServer.prototype, "requiresPayment");
    });

    afterEach(() => {
      requiresPaymentSpy.mockRestore();
    });

    it("returns 402 for a baseline wildcard match, and requiresPayment is called", async () => {
      const res = await buildApp().request("/api/premium/report");
      expect(res.status).toBe(402);
      expect(requiresPaymentSpy).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["U+2028 LINE SEPARATOR", "/api/premium/report%E2%80%A8"],
      ["U+2029 PARAGRAPH SEPARATOR", "/api/premium/report%E2%80%A9"],
      ["LF", "/api/premium/report%0A"],
      ["CR", "/api/premium/report%0D"],
    ])(
      "returns 404 for an encoded %s and never calls requiresPayment (no bypass reaches the paid handler)",
      async (_, path) => {
        const res = await buildApp().request(path);

        expect(res.status).toBe(404);
        expect(requiresPaymentSpy).not.toHaveBeenCalled();
      },
    );

    it("returns 200 (middleware skipped) for an unrelated path", async () => {
      const res = await buildApp().request("/health");
      expect(res.status).toBe(200);
      expect(requiresPaymentSpy).toHaveBeenCalledTimes(1);
    });
  });
});
