import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { paymentMiddleware } from "./index";

const payTo = "0x0000000000000000000000000000000000000001";

/**
 * Starts the app and sends one request with the path exactly as given.
 * `fetch` would normalise a raw "\" to "/", so this uses `http.request`.
 *
 * @param app - The Express app
 * @param path - Raw request target
 * @returns The response status
 */
async function statusOf(app: express.Express, path: string): Promise<number> {
  const server = await new Promise<http.Server>(resolve => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      http
        .request({ host: "127.0.0.1", port, path, agent: false }, res => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject)
        .end();
    });
  } finally {
    server.close();
  }
}

describe("route matching on a real Express router", () => {
  it.each(["/api/users/a%2Fb", "/api/users/a%5Cb", "/api/users/a\\b"])(
    "charges for a parameterised route when the parameter holds a separator: %s",
    async path => {
      const app = express();
      app.use(paymentMiddleware(payTo, { "GET /api/users/[id]": "$0.01" }));
      app.get("/api/users/:id", (_req, res) => {
        res.send("paid content");
      });

      expect(await statusOf(app, path)).toBe(402);
    },
  );

  it("keeps a raw backslash apart from an encoded static route", async () => {
    const app = express();
    app.use(paymentMiddleware(payTo, { "GET /api/users/a%5Cb": "$0.01" }));
    app.get("/api/users/a%5Cb", (_req, res) => {
      res.send("paid content");
    });
    app.get("/api/users/:id", (_req, res) => {
      res.send("public");
    });

    expect(await statusOf(app, "/api/users/a\\b")).toBe(200);
    expect(await statusOf(app, "/api/users/a%5Cb")).toBe(402);
  });

  it.each(["/api/users/%61%5Cb", "/api/users/a%5C%62", "/api/users/%61%2Fb", "/api/users/a%2F%62"])(
    "keeps other escapes apart from an encoded static route: %s",
    async path => {
      const app = express();
      app.use(
        paymentMiddleware(payTo, {
          "GET /api/users/a%5Cb": "$0.01",
          "GET /api/users/a%2Fb": "$0.01",
        }),
      );
      app.get(["/api/users/a%5Cb", "/api/users/a%2Fb"], (_req, res) => {
        res.send("paid content");
      });
      app.get("/api/users/:id", (_req, res) => {
        res.send("public");
      });

      expect(await statusOf(app, path)).toBe(200);
    },
  );
});
