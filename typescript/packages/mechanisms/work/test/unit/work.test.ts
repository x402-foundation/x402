import { describe, expect, it, vi } from "vitest";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  x402HTTPResourceServer,
  type HTTPAdapter,
} from "@x402/core/http";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemePaymentRequiredContext,
  SupportedKind,
  SupportedResponse,
} from "@x402/core/types";
import {
  UINT256_SPACE,
  InMemoryWorkSettlementStore,
  WorkClientScheme,
  WorkFacilitatorScheme,
  WorkServerScheme,
  parseWorkExtra,
  targetForAmount,
  type WorkFacilitatorProfile,
  type WorkJobIssuer,
  type WorkSolver,
} from "../../src";

const NETWORK = "quai:9" as Network;
const PROFILE = "quai/sha256d-v1";
const FINGERPRINT = `0x${"22".repeat(32)}`;
const NOW = 1_800_000_000_000;

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "work",
    network: NETWORK,
    asset: "hash",
    amount: "65536",
    payTo: "0x0123456789abcdef0123456789abcdef01234567",
    maxTimeoutSeconds: 30,
    extra: {
      name: "x402-work",
      version: "1",
      profile: PROFILE,
      job: {
        id: "job-1",
        expiresAt: NOW / 1000 + 30,
        refreshAfter: NOW / 1000 + 10,
        work: { native: "job" },
      },
    },
    ...overrides,
  };
}

function payload(accepted = requirements()): PaymentPayload {
  return {
    x402Version: 2,
    accepted,
    payload: { solution: { nonce: "7" } },
  };
}

function supported(): SupportedKind {
  return {
    x402Version: 2,
    scheme: "work",
    network: NETWORK,
    extra: { name: "x402-work", version: "1", profiles: [PROFILE] },
  };
}

function httpAdapter(payment?: PaymentPayload): HTTPAdapter {
  const header = payment ? encodePaymentSignatureHeader(payment) : undefined;
  return {
    getHeader: name => (name.toLowerCase() === "payment-signature" ? header : undefined),
    getMethod: () => "GET",
    getPath: () => "/core",
    getUrl: () => "https://example.com/core",
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "vitest",
  };
}

describe("work price", () => {
  it("derives the target without a second price field", () => {
    expect(targetForAmount("1")).toBe(UINT256_SPACE - 1n);
    expect(targetForAmount("65536")).toBe((1n << 240n) - 1n);
    expect(targetForAmount(UINT256_SPACE.toString())).toBe(0n);
    for (const amount of ["0", "01", "-1", "1".repeat(79), (UINT256_SPACE + 1n).toString()]) {
      expect(() => targetForAmount(amount)).toThrow();
    }
    expect(() => parseWorkExtra({ ...requirements().extra, profileVersion: "1" })).toThrow(
      "unknown extra fields",
    );
  });
});

describe("work server and client", () => {
  it("issues a current native job and solves the exact advertised requirement", async () => {
    const issue = vi.fn(async () => ({
      id: "job-1",
      expiresAt: NOW / 1000 + 30,
      refreshAfter: NOW / 1000 + 10,
      work: { native: "job" },
    }));
    const issuer: WorkJobIssuer = {
      profile: PROFILE,
      asset: "hash",
      networks: [NETWORK],
      issue,
    };
    const server = new WorkServerScheme({
      issuers: [issuer],
      now: () => NOW,
    });

    const price = await server.parsePrice(
      { amount: "65536", asset: "hash", extra: { profile: PROFILE } },
      NETWORK,
    );
    await expect(
      server.parsePrice({ amount: "1", asset: "share", extra: { profile: PROFILE } }, NETWORK),
    ).rejects.toThrow("does not support");
    const base = requirements({ extra: price.extra ?? {} });
    const enhanced = await server.enhancePaymentRequirements(base, supported());
    const context = {
      requirements: [enhanced],
      resourceInfo: { url: "https://example.com/data" },
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com/data" },
        accepts: [enhanced],
      },
    } satisfies SchemePaymentRequiredContext;
    const [issued] = (await server.enrichPaymentRequiredResponse(context))!;

    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        target: (1n << 240n) - 1n,
        requirements: enhanced,
        resource: context.resourceInfo,
      }),
    );
    expect(issued.extra).toEqual(
      expect.objectContaining({
        name: "x402-work",
        version: "1",
        profile: PROFILE,
      }),
    );

    const solve = vi.fn(async () => ({ nonce: "7" }));
    const solver: WorkSolver = { profile: PROFILE, solve };
    const client = new WorkClientScheme({ solvers: [solver], now: () => NOW });
    const result = await client.createPaymentPayload(2, issued);

    expect(result).toEqual({ x402Version: 2, payload: { solution: { nonce: "7" } } });
    expect(solve).toHaveBeenCalledWith(
      expect.objectContaining({
        target: (1n << 240n) - 1n,
        requirements: issued,
        job: expect.objectContaining({ work: { native: "job" } }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("does not mine an expired job", async () => {
    const solver: WorkSolver = { profile: PROFILE, solve: vi.fn(async () => ({})) };
    const client = new WorkClientScheme({ solvers: [solver], now: () => NOW });
    const stale = requirements({
      extra: {
        ...requirements().extra,
        job: { id: "old", expiresAt: NOW / 1000, work: {} },
      },
    });

    await expect(client.createPaymentPayload(2, stale)).rejects.toThrow("work job expired");
    expect(solver.solve).not.toHaveBeenCalled();
  });

  it("omits an unavailable profile without hiding healthy offers", async () => {
    const healthy = vi.fn(async () => ({
      id: "healthy-job",
      expiresAt: NOW / 1000 + 30,
      work: { native: "healthy" },
    }));
    const server = new WorkServerScheme({
      issuers: [
        {
          profile: "quai/scrypt-v1",
          asset: "hash",
          networks: [NETWORK],
          issue: vi.fn(async () => {
            throw new Error("source unavailable");
          }),
        },
        {
          profile: PROFILE,
          asset: "hash",
          networks: [NETWORK],
          issue: healthy,
        },
      ],
      now: () => NOW,
    });
    const result = await server.enrichPaymentRequiredResponse({
      requirements: [
        requirements({
          extra: { name: "x402-work", version: "1", profile: "quai/scrypt-v1" },
        }),
        requirements({ extra: { name: "x402-work", version: "1", profile: PROFILE } }),
      ],
      resourceInfo: { url: "https://example.com/data" },
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com/data" },
        accepts: [],
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0].extra).toEqual(
      expect.objectContaining({
        profile: PROFILE,
        job: expect.objectContaining({ id: "healthy-job" }),
      }),
    );
    expect(healthy).toHaveBeenCalledOnce();
  });

  it("fails when no profile can issue a requirement", async () => {
    const server = new WorkServerScheme({
      issuers: [
        {
          profile: PROFILE,
          asset: "hash",
          networks: [NETWORK],
          issue: async () => {
            throw new Error("source unavailable");
          },
        },
      ],
      now: () => NOW,
    });

    await expect(
      server.enrichPaymentRequiredResponse({
        requirements: [
          requirements({ extra: { name: "x402-work", version: "1", profile: PROFILE } }),
        ],
        resourceInfo: { url: "https://example.com/data" },
        paymentRequiredResponse: {
          x402Version: 2,
          resource: { url: "https://example.com/data" },
          accepts: [],
        },
      }),
    ).rejects.toThrow("no work profile could issue");
  });

  it("stops before mining a job whose refresh time has arrived", async () => {
    const solver: WorkSolver = { profile: PROFILE, solve: vi.fn(async () => ({})) };
    const client = new WorkClientScheme({ solvers: [solver], now: () => NOW });
    const refresh = requirements({
      extra: {
        ...requirements().extra,
        job: {
          id: "refresh",
          refreshAfter: NOW / 1000,
          expiresAt: NOW / 1000 + 30,
          work: {},
        },
      },
    });

    await expect(client.createPaymentPayload(2, refresh)).rejects.toThrow(
      "work job refresh required",
    );
    expect(solver.solve).not.toHaveBeenCalled();
  });

  it("returns at refresh time even when a solver ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const solver: WorkSolver = {
        profile: PROFILE,
        solve: vi.fn(async context => {
          signal = context.signal;
          return new Promise<Record<string, unknown>>(() => undefined);
        }),
      };
      const client = new WorkClientScheme({ solvers: [solver], now: () => NOW });
      const refresh = requirements({
        extra: {
          ...requirements().extra,
          job: {
            id: "refresh",
            refreshAfter: NOW / 1000 + 1,
            expiresAt: NOW / 1000 + 30,
            work: {},
          },
        },
      });

      const payment = client.createPaymentPayload(2, refresh);
      const rejected = expect(payment).rejects.toThrow("work job refresh required");
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("work facilitator", () => {
  function profile(): WorkFacilitatorProfile {
    return {
      profile: PROFILE,
      asset: "hash",
      networks: [NETWORK],
      fingerprint: vi.fn(async () => FINGERPRINT),
      verify: vi.fn(async () => ({
        score: 1n,
        extra: {
          score: "untrusted",
          fingerprint: "untrusted",
          sourceAccepted: true,
          native: true,
        },
      })),
    };
  }

  it("preserves trusted proof metadata and consumes the solution exactly once", async () => {
    const adapter = profile();
    const facilitator = new WorkFacilitatorScheme({
      profiles: [adapter],
      store: new InMemoryWorkSettlementStore(),
      now: () => NOW,
    });
    const requirement = requirements();
    const payment = payload(requirement);

    expect(facilitator.getExtra(NETWORK)).toEqual({
      name: "x402-work",
      version: "1",
      profiles: [PROFILE],
    });
    expect(await facilitator.verify(payment, requirement)).toEqual({
      isValid: true,
      extra: {
        native: true,
        profile: PROFILE,
        jobId: "job-1",
        score: `0x${"0".repeat(63)}1`,
        fingerprint: FINGERPRINT,
      },
    });

    const settled = await facilitator.settle(payment, requirement);
    expect(settled).toEqual({
      success: true,
      transaction: FINGERPRINT,
      network: NETWORK,
      amount: "65536",
      extra: expect.objectContaining({ fingerprint: FINGERPRINT }),
    });
    expect(settled.extra).not.toHaveProperty("sourceAccepted");
    expect(adapter.verify).toHaveBeenCalledTimes(2);

    const replay = await facilitator.settle(payment, requirement);
    expect(replay).toEqual(
      expect.objectContaining({ success: false, errorReason: "invalid_work_state" }),
    );
    expect(adapter.verify).toHaveBeenCalledTimes(2);
  });

  it("atomically records a binding and rejects conflicting consumption", async () => {
    const store = new InMemoryWorkSettlementStore();
    expect(await store.consume(FINGERPRINT, "binding-a")).toEqual({ status: "consumed" });
    expect(await store.inspect(FINGERPRINT)).toEqual({
      status: "settled",
      binding: "binding-a",
    });
    expect(await store.consume(FINGERPRINT, "binding-a")).toEqual({ status: "settled" });
    expect(await store.consume(FINGERPRINT, "binding-b")).toEqual({ status: "conflict" });
  });

  it("serializes concurrent settlement of the same solution", async () => {
    const adapter = profile();
    const facilitator = new WorkFacilitatorScheme({
      profiles: [adapter],
      store: new InMemoryWorkSettlementStore(),
      now: () => NOW,
    });
    const requirement = requirements();
    const payment = payload(requirement);

    const results = await Promise.all([
      facilitator.settle(payment, requirement),
      facilitator.settle(payment, requirement),
    ]);
    expect(results.filter(result => result.success)).toHaveLength(1);
    expect(results.filter(result => result.errorReason === "invalid_work_settled")).toHaveLength(1);
  });

  it("rejects insufficient work before submission", async () => {
    const adapter = profile();
    adapter.verify = vi.fn(async input => ({
      score: input.target + 1n,
    }));
    const facilitator = new WorkFacilitatorScheme({
      profiles: [adapter],
      store: new InMemoryWorkSettlementStore(),
      now: () => NOW,
    });

    const result = await facilitator.settle(payload(), requirements());
    expect(result).toEqual(
      expect.objectContaining({ success: false, errorReason: "invalid_work_target" }),
    );
  });

  it.each([
    ["amount", () => requirements({ amount: "1" })],
    ["payTo", () => requirements({ payTo: `0x${"34".repeat(20)}` })],
    ["timeout", () => requirements({ maxTimeoutSeconds: 29 })],
    [
      "profile",
      () =>
        requirements({
          extra: { ...requirements().extra, profile: "quai/scrypt-v1" },
        }),
    ],
    [
      "job",
      () =>
        requirements({
          extra: {
            ...requirements().extra,
            job: {
              ...(requirements().extra.job as Record<string, unknown>),
              id: "job-2",
            },
          },
        }),
    ],
  ])("rejects a client-mutated accepted %s before proof evaluation", async (_field, mutate) => {
    const adapter = profile();
    const facilitator = new WorkFacilitatorScheme({
      profiles: [adapter],
      store: new InMemoryWorkSettlementStore(),
      now: () => NOW,
    });

    const result = await facilitator.settle(payload(mutate()), requirements());
    expect(result).toEqual(
      expect.objectContaining({ success: false, errorReason: "invalid_work_payload" }),
    );
    expect(adapter.fingerprint).not.toHaveBeenCalled();
    expect(adapter.verify).not.toHaveBeenCalled();
  });
});

describe("x402 core integration", () => {
  it("preserves the issued job through an HTTP paid retry", async () => {
    const issuer: WorkJobIssuer = {
      profile: PROFILE,
      asset: "hash",
      networks: [NETWORK],
      issue: vi.fn(async () => ({
        id: "core-job",
        expiresAt: NOW / 1000 + 30,
        work: { header: "native" },
      })),
    };
    const solver: WorkSolver = {
      profile: PROFILE,
      solve: async () => ({ nonce: "9" }),
    };
    const profile: WorkFacilitatorProfile = {
      profile: PROFILE,
      asset: "hash",
      networks: [NETWORK],
      fingerprint: async () => FINGERPRINT,
      verify: async () => ({ score: 0n }),
    };

    const facilitator = new x402Facilitator().register(
      NETWORK,
      new WorkFacilitatorScheme({
        profiles: [profile],
        store: new InMemoryWorkSettlementStore(),
        now: () => NOW,
      }),
    );
    const facilitatorClient: FacilitatorClient = {
      getSupported: async () => facilitator.getSupported() as SupportedResponse,
      verify: (payment, requirement) => facilitator.verify(payment, requirement),
      settle: (payment, requirement) => facilitator.settle(payment, requirement),
    };
    const server = new x402ResourceServer(facilitatorClient).register(
      NETWORK,
      new WorkServerScheme({
        issuers: [issuer],
        now: () => NOW,
      }),
    );
    await server.initialize();

    const http = new x402HTTPResourceServer(server, {
      "/core": {
        accepts: {
          scheme: "work",
          network: NETWORK,
          payTo: requirements().payTo,
          price: { amount: "65536", asset: "hash", extra: { profile: PROFILE } },
        },
      },
    });
    const unpaid = await http.processHTTPRequest({
      adapter: httpAdapter(),
      path: "/core",
      method: "GET",
    });
    expect(unpaid.type).toBe("payment-error");
    if (unpaid.type !== "payment-error") throw new Error("expected HTTP 402");
    const required = decodePaymentRequiredHeader(unpaid.response.headers["PAYMENT-REQUIRED"]);
    const payment = await new x402Client()
      .setSpendControls({
        allowedAssets: [{ network: NETWORK, asset: "hash", maxAmountPerPayment: "65536" }],
      })
      .register(NETWORK, new WorkClientScheme({ solvers: [solver], now: () => NOW }))
      .createPaymentPayload(required);
    const paid = await http.processHTTPRequest({
      adapter: httpAdapter(payment),
      path: "/core",
      method: "GET",
    });

    expect(paid.type).toBe("payment-verified");
    expect(issuer.issue).toHaveBeenCalledOnce();
    if (paid.type !== "payment-verified") throw new Error("expected verified payment");
    expect(await http.processSettlement(paid.paymentPayload, paid.paymentRequirements)).toEqual(
      expect.objectContaining({
        success: true,
        transaction: FINGERPRINT,
        amount: "65536",
      }),
    );
  });
});
