import { describe, it, expect } from "vitest";
import {
  x402HTTPResourceServer,
  HTTPRequestContext,
  HTTPAdapter,
} from "../../../src/http/x402HTTPResourceServer";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";

class StubAdapter implements HTTPAdapter {
  getHeader(): string | undefined {
    return undefined;
  }
  getMethod(): string {
    return "GET";
  }
  getPath(): string {
    return "/";
  }
  getUrl(): string {
    return "http://localhost/";
  }
  getAcceptHeader(): string {
    return "";
  }
  getUserAgent(): string {
    return "";
  }
}

type DecodedPathNormalizer = {
  normalizeDecodedPath: (path: string) => string;
};

function context(path: string, method: string = "GET", decodedPath?: string): HTTPRequestContext {
  return {
    adapter: new StubAdapter(),
    path,
    method,
    decodedPath,
  };
}

describe("normalizeDecodedPath", () => {
  const server = new x402HTTPResourceServer({} as x402ResourceServer, {
    "GET /api/premium": { accepts: [] },
  });
  const normalizeDecodedPath = (path: string): string =>
    (server as unknown as DecodedPathNormalizer).normalizeDecodedPath(path);

  it.each([
    ["/api", "/api"],
    ["/api/", "/api"],
    ["/api//users", "/api/users"],
    ["/api?query=1", "/api"],
    ["/api#fragment", "/api"],
    ["", "/"],
    ["/api/premium", "/api/premium"],
  ])("normalizes %s to %s", (inputPath, expected) => {
    expect(normalizeDecodedPath(inputPath)).toBe(expected);
  });

  it("does not re-decode percent-escapes", () => {
    expect(normalizeDecodedPath("/api/x%41")).toBe("/api/x%41");
  });
});

describe("decoded path divergence bypass", () => {
  const server = (pattern: string = "GET /api/premium"): x402HTTPResourceServer =>
    new x402HTTPResourceServer({} as x402ResourceServer, {
      [pattern]: { accepts: [] },
    });

  it.each([["/api%2Fpremium"], ["/api%2fpremium"], ["/%61pi%2Fpremium"]])(
    "literal route requires payment when decoded path matches %s",
    escapedPath => {
      expect(server().requiresPayment(context(escapedPath, "GET", "/api/premium"))).toBe(true);
    },
  );

  it("literal route misses without decoded path", () => {
    expect(server().requiresPayment(context("/api%2Fpremium", "GET", undefined))).toBe(false);
  });

  it("real extra segment still not matched", () => {
    const httpServer = server("GET /api/users/:id");
    expect(httpServer.requiresPayment(context("/api/users/x/y", "GET", "/api/users/x/y"))).toBe(
      false,
    );
  });

  it("unrelated decoded path does not require payment", () => {
    expect(server().requiresPayment(context("/public/report", "GET", "/public/report"))).toBe(
      false,
    );
  });
});
