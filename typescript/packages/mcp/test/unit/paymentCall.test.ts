// Regression cases for per-call payment context (#3750). Adapted from the
// reference cases shared by @epistemedeus on the issue.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { x402Client } from "@x402/core/client";
import type { Network, PaymentRequired, SchemeNetworkClient } from "@x402/core/types";
import { x402MCPClient } from "../../src";

const network = "eip155:84532" as Network;

const paymentRequired: PaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "test-scheme",
      network,
      amount: "1000",
      asset: "0xtoken",
      payTo: "0xrecipient",
      maxTimeoutSeconds: 60,
      extra: {},
    },
  ],
  resource: { url: "mcp://tool/test", description: "Test tool", mimeType: "application/json" },
};

const corrective: PaymentRequired = {
  ...paymentRequired,
  accepts: [{ ...paymentRequired.accepts[0], amount: "2000" }],
};

/**
 * A tool result carrying a PaymentRequired.
 *
 * @param value - The PaymentRequired
 * @returns The tool result
 */
function embedded(value: PaymentRequired) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    isError: true as const,
  };
}

/**
 * A successful tool result.
 *
 * @param text - Result text
 * @returns The tool result
 */
function success(text: string) {
  return { content: [{ type: "text" as const, text }], isError: false as const };
}

/**
 * Polls until a condition holds.
 *
 * @param ready - Condition
 * @param what - Description for the timeout error
 */
async function waitFor(ready: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 1000) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

type RpcParams = { name: string; arguments?: { article?: unknown }; _meta?: unknown };

describe("x402MCPClient per-call payment context", () => {
  let mcp: { callTool: ReturnType<typeof vi.fn> };
  let seen: Array<{ toolName?: string; article?: unknown; amount: string }>;
  let client: x402MCPClient;

  beforeEach(() => {
    seen = [];
    mcp = { callTool: vi.fn() };
    const scheme: SchemeNetworkClient = {
      scheme: "test-scheme",
      async createPaymentPayload(_version, requirements, context) {
        const call = context?.call?.kind === "mcp" ? context.call : undefined;
        seen.push({
          toolName: call?.toolName,
          article: call?.arguments.article,
          amount: requirements.amount,
        });
        return { x402Version: 2, payload: { signature: "scheme_signature" } };
      },
    };
    const payment = new x402Client().register(network, scheme).setSpendControls(false);
    client = new x402MCPClient(mcp as never, payment);
  });

  it("binds each concurrent tool call to its own arguments", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    mcp.callTool.mockImplementation(async (params: RpcParams) => {
      if (!params._meta) return embedded(paymentRequired);
      await gate;
      return success("ok");
    });
    const firstArgs = { article: "one" };
    const first = client.callTool("alpha", firstArgs);
    const second = client.callTool("beta", { article: "two" });
    await waitFor(() => seen.length === 2, "payment context");
    firstArgs.article = "mutated";
    release();
    await Promise.all([first, second]);

    expect(seen.map(item => `${item.toolName}:${item.article}`).sort()).toEqual([
      "alpha:one",
      "beta:two",
    ]);
    expect(JSON.stringify(seen)).not.toContain("scheme_signature");
  });

  it("transmits the committed call on the unpaid, paid and recovery RPCs", async () => {
    const rpc: Array<{ phase: string; name: string; article?: unknown }> = [];
    let releaseUnpaid: () => void = () => {};
    const unpaidGate = new Promise<void>(resolve => {
      releaseUnpaid = resolve;
    });
    let unpaidWaiting = 0;
    let paidCount = 0;
    mcp.callTool.mockImplementation(async (params: RpcParams) => {
      if (!params._meta) {
        unpaidWaiting += 1;
        await unpaidGate;
        rpc.push({ phase: "unpaid", name: params.name, article: params.arguments?.article });
        return embedded(paymentRequired);
      }
      paidCount += 1;
      rpc.push({
        phase: paidCount === 1 ? "paid" : "recovery",
        name: params.name,
        article: params.arguments?.article,
      });
      return paidCount === 1 ? embedded(corrective) : success("ok");
    });
    client.onBeforePayment(context => {
      context.arguments.article = "hook-mutated";
    });
    let recovered = false;
    client.paymentClient.onPaymentResponse(async () => {
      if (recovered) return;
      recovered = true;
      return { recovered: true };
    });

    const args = { article: "committed" };
    const pending = client.callTool("paid_tool", args);
    await waitFor(() => unpaidWaiting === 1, "the unpaid RPC");
    args.article = "caller-mutated";
    releaseUnpaid();
    const result = await pending;

    expect(result.paymentMade).toBe(true);
    expect(seen).toEqual([
      { toolName: "paid_tool", article: "committed", amount: "1000" },
      { toolName: "paid_tool", article: "committed", amount: "2000" },
    ]);
    expect(rpc).toEqual([
      { phase: "unpaid", name: "paid_tool", article: "committed" },
      { phase: "paid", name: "paid_tool", article: "committed" },
      { phase: "recovery", name: "paid_tool", article: "committed" },
    ]);
  });

  it("keeps transmitted arguments stable for a scheme that ignores the call", async () => {
    const legacy: SchemeNetworkClient = {
      scheme: "test-scheme",
      createPaymentPayload: async () => ({
        x402Version: 2,
        payload: { signature: "legacy_signature" },
      }),
    };
    const legacyClient = new x402MCPClient(
      mcp as never,
      new x402Client().register(network, legacy).setSpendControls(false),
    );
    const rpc: Array<{ article?: unknown; paid: boolean }> = [];
    let releaseUnpaid: () => void = () => {};
    const unpaidGate = new Promise<void>(resolve => {
      releaseUnpaid = resolve;
    });
    let unpaidWaiting = 0;
    mcp.callTool.mockImplementation(async (params: RpcParams) => {
      if (!params._meta) {
        unpaidWaiting += 1;
        await unpaidGate;
        rpc.push({ article: params.arguments?.article, paid: false });
        return embedded(paymentRequired);
      }
      rpc.push({ article: params.arguments?.article, paid: true });
      return success("legacy");
    });
    const args = { article: "legacy-committed" };
    const pending = legacyClient.callTool("paid_tool", args);
    await waitFor(() => unpaidWaiting === 1, "the legacy unpaid RPC");
    args.article = "legacy-mutated";
    releaseUnpaid();
    const result = await pending;
    expect(result.paymentMade).toBe(true);
    expect(result.content[0]?.text).toBe("legacy");
    expect(rpc).toEqual([
      { article: "legacy-committed", paid: false },
      { article: "legacy-committed", paid: true },
    ]);
  });

  it("rejects an empty tool name or uncloneable arguments before any RPC", async () => {
    await expect(client.callTool("paid_tool", { fn: () => undefined })).rejects.toThrow(
      "invalid_mcp_call_context",
    );
    await expect(client.callTool("", { article: "one" })).rejects.toThrow(
      "invalid_mcp_call_context",
    );
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});
