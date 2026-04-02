import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  withMnemoPay,
  withMnemoPayAgent,
  recallEndpointInsight,
  rememberPaymentOutcome,
} from "./middleware";
import type { MnemoPayAgent, MnemoPayPaymentResult } from "./types";

/**
 * Creates a mock MnemoPay agent for testing.
 *
 * @returns A mock agent with spied methods.
 */
function createMockAgent(): MnemoPayAgent & {
  remember: ReturnType<typeof vi.fn>;
  recall: ReturnType<typeof vi.fn>;
  charge: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
  refund: ReturnType<typeof vi.fn>;
  balance: ReturnType<typeof vi.fn>;
} {
  return {
    remember: vi.fn().mockResolvedValue(undefined),
    recall: vi.fn().mockResolvedValue([]),
    charge: vi.fn().mockResolvedValue("tx-123"),
    settle: vi.fn().mockResolvedValue(undefined),
    refund: vi.fn().mockResolvedValue(undefined),
    balance: vi.fn().mockReturnValue({ wallet: 100, reputation: 0.8 }),
  };
}

/**
 * Creates a mock fetch function that returns a configurable response.
 *
 * @param status - HTTP status code to return.
 * @param headers - Headers to include in the response.
 * @returns A mock fetch function.
 */
function createMockFetch(
  status: number,
  headers: Record<string, string> = {},
): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: "ok" }), {
      status,
      headers: new Headers(headers),
    }),
  );
}

describe("withMnemoPay", () => {
  let agent: ReturnType<typeof createMockAgent>;

  beforeEach(() => {
    agent = createMockAgent();
  });

  it("should pass through non-402 responses and remember the outcome", async () => {
    const mockFetch = createMockFetch(200);
    const wrappedFetch = withMnemoPay(mockFetch, { agent });

    const response = await wrappedFetch("https://api.example.com/data");

    expect(response.status).toBe(200);
    expect(agent.recall).toHaveBeenCalledWith(
      "x402 payment to https://api.example.com/data",
      5,
    );
    expect(agent.remember).toHaveBeenCalledWith(
      expect.stringContaining("success"),
      expect.objectContaining({ tags: expect.arrayContaining(["x402", "success"]) }),
    );
  });

  it("should remember failed payment outcomes", async () => {
    const mockFetch = createMockFetch(402);
    const wrappedFetch = withMnemoPay(mockFetch, { agent });

    const response = await wrappedFetch("https://api.example.com/paid");

    expect(response.status).toBe(402);
    expect(agent.remember).toHaveBeenCalledWith(
      expect.stringContaining("failure"),
      expect.objectContaining({ tags: expect.arrayContaining(["x402", "failure"]) }),
    );
  });

  it("should settle transactions on successful payment", async () => {
    const mockFetch = createMockFetch(200, {
      "PAYMENT-RESPONSE": btoa(JSON.stringify({ amount: 0.05 })),
    });
    const wrappedFetch = withMnemoPay(mockFetch, { agent });

    await wrappedFetch("https://api.example.com/paid");

    expect(agent.charge).toHaveBeenCalledWith(0.05, "x402 payment to https://api.example.com/paid");
    expect(agent.settle).toHaveBeenCalledWith("tx-123");
  });

  it("should refund transactions on failed payment", async () => {
    const mockFetch = createMockFetch(500, {
      "PAYMENT-RESPONSE": btoa(JSON.stringify({ amount: 0.05 })),
    });
    const wrappedFetch = withMnemoPay(mockFetch, { agent });

    await wrappedFetch("https://api.example.com/paid");

    expect(agent.charge).toHaveBeenCalledWith(0.05, "x402 payment to https://api.example.com/paid");
    expect(agent.refund).toHaveBeenCalledWith("tx-123");
  });

  it("should recall memories before each request", async () => {
    agent.recall.mockResolvedValue([
      { content: "x402 payment to https://api.example.com/paid: success, cost: $0.03" },
      { content: "x402 payment to https://api.example.com/paid: success, cost: $0.04" },
    ]);
    const mockFetch = createMockFetch(200);
    const wrappedFetch = withMnemoPay(mockFetch, { agent, recallLimit: 10 });

    await wrappedFetch("https://api.example.com/paid");

    expect(agent.recall).toHaveBeenCalledWith(
      "x402 payment to https://api.example.com/paid",
      10,
    );
  });

  it("should handle recall failures gracefully", async () => {
    agent.recall.mockRejectedValue(new Error("Memory DB offline"));
    const mockFetch = createMockFetch(200);
    const wrappedFetch = withMnemoPay(mockFetch, { agent });

    const response = await wrappedFetch("https://api.example.com/data");

    expect(response.status).toBe(200);
  });

  it("should handle remember failures gracefully", async () => {
    agent.remember.mockRejectedValue(new Error("Storage full"));
    const mockFetch = createMockFetch(200);
    const wrappedFetch = withMnemoPay(mockFetch, { agent });

    const response = await wrappedFetch("https://api.example.com/data");

    expect(response.status).toBe(200);
  });

  it("should propagate fetch errors after remembering the failure", async () => {
    const errorFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    const wrappedFetch = withMnemoPay(errorFetch as typeof globalThis.fetch, { agent });

    await expect(wrappedFetch("https://api.example.com/data")).rejects.toThrow("Network error");
    expect(agent.remember).toHaveBeenCalledWith(
      expect.stringContaining("failure"),
      expect.objectContaining({ importance: 0.9 }),
    );
  });

  it("should use custom recallLimit", async () => {
    const mockFetch = createMockFetch(200);
    const wrappedFetch = withMnemoPay(mockFetch, { agent, recallLimit: 3 });

    await wrappedFetch("https://api.example.com/data");

    expect(agent.recall).toHaveBeenCalledWith(expect.any(String), 3);
  });
});

describe("withMnemoPayAgent", () => {
  it("should create a wrapped fetch with default config", async () => {
    const agent = createMockAgent();
    const mockFetch = createMockFetch(200);
    const wrappedFetch = withMnemoPayAgent(mockFetch, agent);

    const response = await wrappedFetch("https://api.example.com/data");

    expect(response.status).toBe(200);
    expect(agent.recall).toHaveBeenCalled();
  });
});

describe("recallEndpointInsight", () => {
  it("should return undefined when no memories exist", async () => {
    const agent = createMockAgent();
    agent.recall.mockResolvedValue([]);

    const insight = await recallEndpointInsight(agent, "https://api.example.com/paid");

    expect(insight).toBeUndefined();
  });

  it("should build insight from memories with cost info", async () => {
    const agent = createMockAgent();
    agent.recall.mockResolvedValue([
      { content: "x402 payment to endpoint: success, cost: $0.03" },
      { content: "x402 payment to endpoint: success, cost: $0.05" },
      { content: "x402 payment to endpoint: failure, cost: $0.04" },
    ]);

    const insight = await recallEndpointInsight(agent, "https://api.example.com/paid");

    expect(insight).toBeDefined();
    expect(insight!.interactionCount).toBe(3);
    expect(insight!.averageCost).toBeCloseTo(0.04, 2);
    expect(insight!.successRate).toBeCloseTo(2 / 3, 2);
  });

  it("should handle recall errors gracefully", async () => {
    const agent = createMockAgent();
    agent.recall.mockRejectedValue(new Error("DB error"));

    const insight = await recallEndpointInsight(agent, "https://api.example.com/paid");

    expect(insight).toBeUndefined();
  });
});

describe("rememberPaymentOutcome", () => {
  it("should store success memory and settle transaction", async () => {
    const agent = createMockAgent();
    const result: MnemoPayPaymentResult = {
      success: true,
      transactionId: "tx-456",
      endpoint: "https://api.example.com/paid",
      cost: 0.05,
    };

    await rememberPaymentOutcome(agent, result);

    expect(agent.remember).toHaveBeenCalledWith(
      "x402 payment to https://api.example.com/paid: success, cost: $0.05",
      expect.objectContaining({
        importance: 0.7,
        tags: ["x402", "success", "cost-tracked"],
      }),
    );
    expect(agent.settle).toHaveBeenCalledWith("tx-456");
  });

  it("should store failure memory and refund transaction", async () => {
    const agent = createMockAgent();
    const result: MnemoPayPaymentResult = {
      success: false,
      transactionId: "tx-789",
      endpoint: "https://api.example.com/paid",
    };

    await rememberPaymentOutcome(agent, result);

    expect(agent.remember).toHaveBeenCalledWith(
      "x402 payment to https://api.example.com/paid: failure",
      expect.objectContaining({
        importance: 0.9,
        tags: ["x402", "failure"],
      }),
    );
    expect(agent.refund).toHaveBeenCalledWith("tx-789");
  });

  it("should not call settle/refund when there is no transactionId", async () => {
    const agent = createMockAgent();
    const result: MnemoPayPaymentResult = {
      success: true,
      endpoint: "https://api.example.com/free",
    };

    await rememberPaymentOutcome(agent, result);

    expect(agent.settle).not.toHaveBeenCalled();
    expect(agent.refund).not.toHaveBeenCalled();
  });
});
