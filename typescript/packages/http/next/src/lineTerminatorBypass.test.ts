import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { x402ResourceServer } from "@x402/core/server";
import { paymentProxy } from "./index";

/**
 * Reproduces CAT finding f2e83cec-d5d5-4076-bd4e-55e060d216b1 against the
 * real Next.js proxy (no `@x402/core/server` mocking, unlike index.test.ts).
 *
 * `NextRequest.nextUrl.pathname` is backed by the WHATWG `URL` class, which
 * does not decode percent-escapes — `new URL("https://x/a%E2%80%A8").pathname`
 * stays `"/a%E2%80%A8"`. So Next hands `x402HTTPResourceServer` the same
 * still-encoded path Express/Fastify do, and the payment gate bypass is
 * reachable through Next exactly as described in the finding.
 */
describe("next end-to-end: percent-encoded line terminator under wildcard route", () => {
  /**
   * Builds a Next.js payment proxy protecting a wildcard route, backed by a
   * real `x402ResourceServer` (not mocked).
   *
   * @returns The configured proxy handler.
   */
  function buildProxy() {
    const resourceServer = new x402ResourceServer();
    return paymentProxy(
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
    );
  }

  it("returns 402 for a baseline wildcard match", async () => {
    const res = await buildProxy()(new NextRequest("https://example.com/api/premium/report"));
    expect(res.status).toBe(402);
  });

  it("returns 402 even when the tail contains %E2%80%A8 (U+2028 LINE SEPARATOR)", async () => {
    const res = await buildProxy()(
      new NextRequest("https://example.com/api/premium/report%E2%80%A8"),
    );
    expect(res.status).toBe(402);
  });

  it("returns 402 even when the tail contains %E2%80%A9 (U+2029 PARAGRAPH SEPARATOR)", async () => {
    const res = await buildProxy()(
      new NextRequest("https://example.com/api/premium/report%E2%80%A9"),
    );
    expect(res.status).toBe(402);
  });

  it("returns 402 even when the tail contains %0A (encoded LF)", async () => {
    const res = await buildProxy()(new NextRequest("https://example.com/api/premium/report%0A"));
    expect(res.status).toBe(402);
  });

  it("returns 402 even when the tail contains %0D (encoded CR)", async () => {
    const res = await buildProxy()(new NextRequest("https://example.com/api/premium/report%0D"));
    expect(res.status).toBe(402);
  });

  it("returns NextResponse.next() (middleware skipped) for an unrelated path", async () => {
    const res = await buildProxy()(new NextRequest("https://example.com/health"));
    // NextResponse.next() is a 200 passthrough carrying this signal header.
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
