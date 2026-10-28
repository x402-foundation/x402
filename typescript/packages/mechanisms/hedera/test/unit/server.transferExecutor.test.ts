import { describe, expect, it } from "vitest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import {
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPResponseInstructions,
  RouteConfigurationError,
  resolvePaymentFlow,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import type { Network, PaymentRequirements, Price } from "@x402/core/types";
import { ExactHederaScheme } from "../../src/exact/server/scheme";

const NETWORK: Network = "hedera:testnet";
const FEE_PAYER = "0.0.5001";
const PAY_TO = "0.0.3001";
const TOKEN_PRICE: Price = { amount: "1000", asset: "0.0.2001", extra: { token: "USDC" } };

/**
 * Builds the `/supported` kind extra of a facilitator with `transferExecutor` enabled.
 *
 * @param executors - Advertised executors
 * @returns Kind extra
 */
function teKind(executors: string[]): Record<string, unknown> {
  return {
    feePayer: FEE_PAYER,
    assetTransferMethods: ["cryptoTransfer", "transferExecutor"],
    executors,
  };
}

type QuoteOptions = {
  kindExtra?: Record<string, unknown>;
  routeExtra?: Record<string, unknown>;
  price?: Price;
};

/**
 * Builds a facilitator client that only answers `/supported`.
 *
 * @param kindExtra - `extra` of the single exact Hedera kind it advertises
 * @returns The facilitator client
 */
function stubFacilitator(kindExtra: Record<string, unknown> | undefined): FacilitatorClient {
  return {
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: kindExtra }],
      extensions: [],
      signers: {},
    }),
    verify: async () => {
      throw new Error("verify is not used by these tests");
    },
    settle: async () => {
      throw new Error("settle is not used by these tests");
    },
  };
}

/**
 * Starts core's HTTP resource server with the Hedera server scheme and one route.
 *
 * @param options - Facilitator kind extra, route extra and price
 * @returns The initialized HTTP resource server
 */
async function startServer(options: QuoteOptions = {}): Promise<x402HTTPResourceServer> {
  const { routeExtra, price = TOKEN_PRICE } = options;
  // An explicit `kindExtra: undefined` means a kind with no extra at all.
  const kindExtra = "kindExtra" in options ? options.kindExtra : { feePayer: FEE_PAYER };
  const resourceServer = new x402ResourceServer(stubFacilitator(kindExtra));
  resourceServer.register(NETWORK, new ExactHederaScheme());
  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "GET /paid": {
      accepts: { scheme: "exact", network: NETWORK, payTo: PAY_TO, price, extra: routeExtra },
    },
  });
  await httpServer.initialize();
  return httpServer;
}

/**
 * Requests the protected route without payment.
 *
 * @param httpServer - Initialized HTTP resource server
 * @returns The 402 response
 */
async function requestUnpaid(
  httpServer: x402HTTPResourceServer,
): Promise<HTTPResponseInstructions> {
  const adapter: HTTPAdapter = {
    getHeader: () => undefined,
    getMethod: () => "GET",
    getPath: () => "/paid",
    getUrl: () => "https://merchant.example/paid",
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "vitest",
  };
  const result = await httpServer.processHTTPRequest({ adapter, path: "/paid", method: "GET" });
  if (result.type !== "payment-error") {
    throw new Error(`expected a 402, got ${result.type}`);
  }
  return result.response;
}

/**
 * Quotes the route through core and decodes the requirement from the 402 header.
 *
 * @param options - Facilitator kind extra, route extra and price
 * @returns The single requirement on the wire
 */
async function quoteThroughCore(options: QuoteOptions = {}): Promise<PaymentRequirements> {
  const response = await requestUnpaid(await startServer(options));
  return decodePaymentRequiredHeader(response.headers["PAYMENT-REQUIRED"]).accepts[0];
}

/**
 * Builds base requirements as core passes them to the scheme.
 *
 * @param extra - Requirements extra
 * @returns Payment requirements
 */
function requirementsWith(extra: Record<string, unknown>): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: "1000",
    asset: "0.0.2001",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra,
  };
}

describe("ExactHedera payment flows resolved by core", () => {
  const scheme = new ExactHederaScheme();

  it("resolves a transferExecutor quote to the authorization flow by default", () => {
    expect(
      resolvePaymentFlow(scheme, requirementsWith({ assetTransferMethod: "transferExecutor" })),
    ).toEqual({ assetTransferMethod: "transferExecutor", paymentFlow: "authorization" });
  });

  it.each(["authorization", "upfront"])(
    "resolves a transferExecutor quote with the %s flow",
    paymentFlow => {
      expect(
        resolvePaymentFlow(
          scheme,
          requirementsWith({ assetTransferMethod: "transferExecutor", paymentFlow }),
        ),
      ).toEqual({ assetTransferMethod: "transferExecutor", paymentFlow });
    },
  );

  it("rejects a transferExecutor quote with the escrow flow", () => {
    expect(() =>
      resolvePaymentFlow(
        scheme,
        requirementsWith({ assetTransferMethod: "transferExecutor", paymentFlow: "escrow" }),
      ),
    ).toThrow('assetTransferMethod "transferExecutor" does not support paymentFlow "escrow"');
  });

  it("resolves an explicit cryptoTransfer quote", () => {
    expect(
      resolvePaymentFlow(scheme, requirementsWith({ assetTransferMethod: "cryptoTransfer" })),
    ).toEqual({ assetTransferMethod: "cryptoTransfer", paymentFlow: "authorization" });
  });

  it.each(["authorization", "upfront"])(
    "resolves an omitted method to cryptoTransfer with the %s flow",
    paymentFlow => {
      expect(resolvePaymentFlow(scheme, requirementsWith({ paymentFlow }))).toEqual({
        assetTransferMethod: "cryptoTransfer",
        paymentFlow,
      });
    },
  );
});

describe("ExactHedera server enhancePaymentRequirements", () => {
  it("reports a refused transferExecutor quote as a rejected promise", async () => {
    const scheme = new ExactHederaScheme();
    const kind = {
      x402Version: 2,
      scheme: "exact",
      network: NETWORK,
      extra: { feePayer: FEE_PAYER },
    };

    let quote: Promise<PaymentRequirements> | undefined;
    expect(() => {
      quote = scheme.enhancePaymentRequirements(
        requirementsWith({ assetTransferMethod: "transferExecutor" }),
        kind,
        [],
      );
    }).not.toThrow();
    await expect(quote).rejects.toThrow(
      "Facilitator does not offer transferExecutor on hedera:testnet",
    );
  });
});

describe("ExactHedera server quotes through core", () => {
  describe("startup", () => {
    it("accepts a transferExecutor route", async () => {
      await expect(
        startServer({
          kindExtra: { feePayer: FEE_PAYER, executors: ["0.0.7000"] },
          routeExtra: { assetTransferMethod: "transferExecutor" },
        }),
      ).resolves.toBeInstanceOf(x402HTTPResourceServer);
    });

    it("rejects a transferExecutor route with the escrow flow", async () => {
      await expect(
        startServer({
          kindExtra: { feePayer: FEE_PAYER, executors: ["0.0.7000"] },
          routeExtra: { assetTransferMethod: "transferExecutor", paymentFlow: "escrow" },
        }),
      ).rejects.toThrow(RouteConfigurationError);
    });

    it("rejects an undefined method", async () => {
      await expect(startServer({ routeExtra: { assetTransferMethod: "permit2" } })).rejects.toThrow(
        RouteConfigurationError,
      );
    });
  });

  it.each([
    ['an explicit "default"', "default", '{"token":"USDC","feePayer":"0.0.5001"}'],
    ["a null", null, '{"token":"USDC","assetTransferMethod":null,"feePayer":"0.0.5001"}'],
  ])("quotes %s method as cryptoTransfer", async (_, assetTransferMethod, wireExtra) => {
    const accepted = await quoteThroughCore({
      kindExtra: teKind(["0.0.7000"]),
      routeExtra: { assetTransferMethod },
    });

    expect(JSON.stringify(accepted.extra)).toBe(wireExtra);
  });

  describe("transferExecutor quotes", () => {
    it("copies the facilitator's executors next to feePayer when the merchant names none", async () => {
      const accepted = await quoteThroughCore({
        kindExtra: teKind(["0.0.7000", "0.0.7001"]),
        routeExtra: { assetTransferMethod: "transferExecutor" },
      });

      expect(JSON.stringify(accepted.extra)).toBe(
        '{"token":"USDC","assetTransferMethod":"transferExecutor",' +
          '"executors":["0.0.7000","0.0.7001"],"feePayer":"0.0.5001"}',
      );
    });
    it("quotes the upfront flow on the wire", async () => {
      const accepted = await quoteThroughCore({
        kindExtra: teKind(["0.0.7000"]),
        routeExtra: { assetTransferMethod: "transferExecutor", paymentFlow: "upfront" },
      });

      expect(JSON.stringify(accepted.extra)).toBe(
        '{"token":"USDC","assetTransferMethod":"transferExecutor","paymentFlow":"upfront",' +
          '"executors":["0.0.7000"],"feePayer":"0.0.5001"}',
      );
    });

    it("narrows to the merchant's executors, in the merchant's order", async () => {
      const accepted = await quoteThroughCore({
        kindExtra: teKind(["0.0.7000", "0.0.7001", "0.0.7002"]),
        routeExtra: {
          assetTransferMethod: "transferExecutor",
          executors: ["0.0.7002", "0.0.7000"],
        },
      });

      expect(accepted.extra.executors).toEqual(["0.0.7002", "0.0.7000"]);
    });

    it.each([
      ["among advertised ones", ["0.0.7000", "0.0.9999"]],
      ["alone", ["0.0.9999"]],
    ])(
      "refuses to quote a merchant executor the facilitator does not advertise, %s, naming it",
      async (_, executors) => {
        const httpServer = await startServer({
          kindExtra: teKind(["0.0.7000"]),
          routeExtra: { assetTransferMethod: "transferExecutor", executors },
        });

        await expect(requestUnpaid(httpServer)).rejects.toThrow(
          "Merchant executor 0.0.9999 is not advertised by the facilitator on hedera:testnet",
        );
      },
    );

    it('keeps the merchant\'s specific executors when the facilitator advertises "*"', async () => {
      const accepted = await quoteThroughCore({
        kindExtra: teKind(["*"]),
        routeExtra: {
          assetTransferMethod: "transferExecutor",
          executors: ["0.0.8000", "0.0.8001"],
        },
      });

      expect(accepted.extra.executors).toEqual(["0.0.8000", "0.0.8001"]);
    });

    it.each([
      ["copies it", undefined, ["*"]],
      ["keeps the merchant's", ["*"], ["*"]],
    ])(
      'passes "*" through when the facilitator advertises it: %s',
      async (_, requested, expected) => {
        const accepted = await quoteThroughCore({
          kindExtra: teKind(["*"]),
          routeExtra: { assetTransferMethod: "transferExecutor", executors: requested },
        });

        expect(accepted.extra.executors).toEqual(expected);
      },
    );

    it('refuses to quote a merchant "*" the facilitator does not advertise', async () => {
      const httpServer = await startServer({
        kindExtra: teKind(["0.0.7000"]),
        routeExtra: { assetTransferMethod: "transferExecutor", executors: ["*", "0.0.7000"] },
      });

      await expect(requestUnpaid(httpServer)).rejects.toThrow(
        "Merchant executor * is not advertised by the facilitator on hedera:testnet",
      );
    });

    it.each([
      ["a string", "0.0.7000"],
      ["null", null],
      ["a non-string entry", ["0.0.7000", 7001]],
      ["an empty array", []],
    ])("refuses to quote when the merchant's executors are %s", async (_, requested) => {
      const httpServer = await startServer({
        kindExtra: teKind(["0.0.7000"]),
        routeExtra: { assetTransferMethod: "transferExecutor", executors: requested },
      });

      await expect(requestUnpaid(httpServer)).rejects.toThrow(
        "extra.executors must be a non-empty array of executor ids",
      );
    });

    it.each([
      ["a non-empty array", [{ payTo: "0.0.3002", amount: "100" }]],
      ["an object", { payTo: "0.0.3002", amount: "100" }],
      ["a string", "0.0.3002"],
      ["a number", 1],
    ])(
      "refuses to quote an extra.splits that is %s, which the facilitator does not advertise",
      async (_, splits) => {
        const httpServer = await startServer({
          kindExtra: teKind(["0.0.7000"]),
          routeExtra: { assetTransferMethod: "transferExecutor", splits },
        });

        await expect(requestUnpaid(httpServer)).rejects.toThrow(
          "transferExecutor does not implement extra.splits",
        );
      },
    );

    it.each([
      ["an empty array", []],
      ["null", null],
    ])("quotes an extra.splits that is %s as given", async (_, splits) => {
      const accepted = await quoteThroughCore({
        kindExtra: teKind(["0.0.7000"]),
        routeExtra: { assetTransferMethod: "transferExecutor", splits },
      });

      expect(accepted.extra.splits).toEqual(splits);
    });

    it.each([
      [
        "assetTransferMethods without transferExecutor",
        { feePayer: FEE_PAYER, assetTransferMethods: ["cryptoTransfer"], executors: ["0.0.7000"] },
      ],
      ["no executors", { feePayer: FEE_PAYER }],
      ["an empty executor list", { feePayer: FEE_PAYER, executors: [] }],
      ["a malformed executor list", { feePayer: FEE_PAYER, executors: "0.0.7000" }],
      ["no extra at all", undefined],
    ])("refuses to quote when the facilitator kind has %s", async (_, kindExtra) => {
      const httpServer = await startServer({
        kindExtra,
        routeExtra: { assetTransferMethod: "transferExecutor" },
      });

      await expect(requestUnpaid(httpServer)).rejects.toThrow(
        "Facilitator does not offer transferExecutor on hedera:testnet",
      );
    });
  });

  it("keeps an explicit cryptoTransfer on the wire", async () => {
    const accepted = await quoteThroughCore({
      routeExtra: { assetTransferMethod: "cryptoTransfer" },
    });

    expect(JSON.stringify(accepted.extra)).toBe(
      '{"token":"USDC","assetTransferMethod":"cryptoTransfer","feePayer":"0.0.5001"}',
    );
  });

  describe("wire output when assetTransferMethod is omitted (unchanged from 2.28)", () => {
    it("keeps the 2.28 requirement bytes, extra key order included", async () => {
      const accepted = await quoteThroughCore({ routeExtra: { custom: "value" } });

      expect(JSON.stringify(accepted)).toBe(
        '{"scheme":"exact","network":"hedera:testnet","amount":"1000","asset":"0.0.2001",' +
          '"payTo":"0.0.3001","maxTimeoutSeconds":300,' +
          '"extra":{"token":"USDC","custom":"value","feePayer":"0.0.5001"}}',
      );
    });

    it("ignores a facilitator's transferExecutor advertisement", async () => {
      const accepted = await quoteThroughCore({
        kindExtra: {
          feePayer: FEE_PAYER,
          assetTransferMethods: ["cryptoTransfer", "transferExecutor"],
          executors: ["0.0.7000"],
        },
        routeExtra: { custom: "value" },
      });

      expect(JSON.stringify(accepted.extra)).toBe(
        '{"token":"USDC","custom":"value","feePayer":"0.0.5001"}',
      );
    });

    it("keeps the 2.28 upfront extra", async () => {
      const accepted = await quoteThroughCore({
        price: { amount: "1000", asset: "0.0.2001" },
        routeExtra: { paymentFlow: "upfront" },
      });

      expect(JSON.stringify(accepted.extra)).toBe(
        '{"paymentFlow":"upfront","feePayer":"0.0.5001"}',
      );
    });

    it("omits feePayer when the facilitator advertises none", async () => {
      const accepted = await quoteThroughCore({
        kindExtra: undefined,
        routeExtra: { custom: "value" },
      });

      expect(JSON.stringify(accepted.extra)).toBe('{"token":"USDC","custom":"value"}');
    });
  });
});
