import { describe, expect, it } from "vitest";
import { checkIfBazaarNeeded, type RouteConfig } from "../../../src/http/x402HTTPResourceServer";

function route(extensions?: Record<string, unknown>): RouteConfig {
  return { accepts: [], extensions } as RouteConfig;
}

describe("checkIfBazaarNeeded", () => {
  it("detects bazaar on a single route", () => {
    expect(checkIfBazaarNeeded(route({ bazaar: {} }))).toBe(true);
  });

  it("returns false when a single route does not declare bazaar", () => {
    expect(checkIfBazaarNeeded(route())).toBe(false);
    expect(checkIfBazaarNeeded(route({}))).toBe(false);
  });

  it("detects bazaar on any entry in a route map", () => {
    expect(
      checkIfBazaarNeeded({
        "/free": route(),
        "/paid": route({ bazaar: { schema: true } }),
      }),
    ).toBe(true);
  });

  it("returns false when no route in a map declares bazaar", () => {
    expect(
      checkIfBazaarNeeded({
        "/free": route(),
        "/other": route({}),
      }),
    ).toBe(false);
  });
});
