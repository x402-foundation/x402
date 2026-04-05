import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import type { Network, PaymentRequired } from "@x402/core/types";
import {
  CashFacilitatorClient,
  CashSchemeNetworkClient,
  CashSchemeNetworkFacilitator,
  CashSchemeNetworkServer,
} from "../../../core/test/mocks/cash";
import {
  OPERATION_BINDING,
  declareOperationBindingExtension,
  operationBindingResourceServerExtension,
} from "@x402/extensions";
import { wrapFetchWithPayment } from "../../fetch/src";
import { paymentMiddleware } from "./index";

describe("operation-binding express HTTP flow", () => {
  let httpServer: Server | undefined;

  afterEach(async () => {
    if (!httpServer) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      httpServer?.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    httpServer = undefined;
  });

  it("surfaces operation-binding metadata during a paid fetch flow", async () => {
    const facilitator = new x402Facilitator().register(
      "x402:cash",
      new CashSchemeNetworkFacilitator(),
    );
    const facilitatorClient = new CashFacilitatorClient(facilitator);

    const server = new x402ResourceServer(facilitatorClient);
    server.register("x402:cash", new CashSchemeNetworkServer());
    server.registerExtension(operationBindingResourceServerExtension);
    await server.initialize();

    const app = express();
    app.use(
      paymentMiddleware(
        {
          "GET /api/operation-binding": {
            accepts: {
              scheme: "cash",
              payTo: "merchant@example.com",
              price: "$0.10",
              network: "x402:cash" as Network,
            },
            description: "Protected operation-binding endpoint",
            mimeType: "application/json",
            extensions: {
              [OPERATION_BINDING]: declareOperationBindingExtension({
                operationId: "cash.operationBinding",
                policyVersion: "2026-04-04",
                bindBody: false,
              }),
            },
          },
        },
        server,
      ),
    );

    app.get("/api/operation-binding", (req, res) => {
      res.json({
        ok: true,
        query: req.query,
      });
    });

    httpServer = await new Promise<Server>(resolve => {
      const listeningServer = app.listen(0, () => resolve(listeningServer));
    });

    const port = (httpServer.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const paymentClient = new x402Client().register(
      "x402:cash",
      new CashSchemeNetworkClient("John"),
    );

    let capturedPaymentRequired: PaymentRequired | undefined;
    const httpClient = new x402HTTPClient(paymentClient).onPaymentRequired(
      async ({ paymentRequired }) => {
        capturedPaymentRequired = paymentRequired;
      },
    );

    const response = await wrapFetchWithPayment(fetch, httpClient)(
      `${baseUrl}/api/operation-binding?units=metric&lang=en`,
      {
        method: "GET",
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("PAYMENT-RESPONSE")).toBeTruthy();

    const settlement = httpClient.getPaymentSettleResponse(name => response.headers.get(name));
    expect(settlement.success).toBe(true);
    expect(settlement.network).toBe("x402:cash");

    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      query: {
        lang: "en",
        units: "metric",
      },
    });

    expect(capturedPaymentRequired).toBeDefined();
    const extension = capturedPaymentRequired?.extensions?.[OPERATION_BINDING] as
      | { info?: Record<string, unknown> }
      | undefined;

    expect(extension?.info).toMatchObject({
      transport: "http",
      method: "GET",
      pathTemplate: "/api/operation-binding",
      operationId: "cash.operationBinding",
      policyVersion: "2026-04-04",
      canonicalization: "rfc8785-jcs",
      digestAlgorithm: "sha-256",
      bindPathParams: true,
      bindQuery: true,
      bindBody: false,
    });

    const resourceUrl = new URL(extension?.info?.resourceUrl as string);
    expect(resourceUrl.pathname).toBe("/api/operation-binding");
    expect(resourceUrl.searchParams.get("units")).toBe("metric");
    expect(resourceUrl.searchParams.get("lang")).toBe("en");
  });
});
