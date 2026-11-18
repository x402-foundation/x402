/**
 * x402MCPClient against a server that controls the 402 terms, using a real
 * x402Client so default spend controls are exercised (client.test.ts mocks it).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { x402MCPClient } from "../../src";
import type { PaymentRequired, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { x402Client } from "@x402/core/client";

const NETWORK = "eip155:84532";
const USDC = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // stands in for a default asset
const PAY_TO = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x2222222222222222222222222222222222222222";

const accept = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: NETWORK,
  amount: "10000", // $0.01
  asset: USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: {},
  ...overrides,
});

const paymentRequired = (overrides: Partial<PaymentRequirements> = {}): PaymentRequired => ({
  x402Version: 2,
  accepts: [accept(overrides)],
  error: "Payment required",
  resource: { url: "mcp://tool/quote", description: "Quote", mimeType: "application/json" },
});

const asToolError = (pr: PaymentRequired) => ({
  content: [{ type: "text" as const, text: JSON.stringify(pr) }],
  isError: true as const,
});

describe("x402MCPClient with a malicious server (real x402Client)", () => {
  let scheme: SchemeNetworkClient & { createPaymentPayload: ReturnType<typeof vi.fn> };
  let callTool: ReturnType<typeof vi.fn>;
  let mcp: x402MCPClient;

  beforeEach(() => {
    scheme = {
      scheme: "exact",
      findDefaultAsset: (asset, network) =>
        network === NETWORK && asset.toLowerCase() === USDC.toLowerCase()
          ? { asset: USDC, decimals: 6, symbol: "USDC" }
          : undefined,
      // Recover on any corrective 402, as batch-settlement does for its own errors.
      schemeHooks: {
        onPaymentResponse: async ctx => (ctx.paymentRequired ? { recovered: true } : undefined),
      },
      createPaymentPayload: vi.fn(async (x402Version: number) => ({
        x402Version,
        payload: { signature: "0xsig" },
      })),
    };
    callTool = vi.fn();
    mcp = new x402MCPClient(
      { callTool } as unknown as ConstructorParameters<typeof x402MCPClient>[0],
      new x402Client().register(NETWORK, scheme),
    );
  });

  it("does not sign an amount above the default $1 cap", async () => {
    callTool.mockResolvedValueOnce(asToolError(paymentRequired({ amount: "1000001" })));

    await expect(mcp.callTool("quote")).rejects.toThrow(/spendControls/);
    expect(scheme.createPaymentPayload).not.toHaveBeenCalled();
  });

  it("does not sign a non-default asset", async () => {
    callTool.mockResolvedValueOnce(
      asToolError(paymentRequired({ asset: "0x3333333333333333333333333333333333333333" })),
    );

    await expect(mcp.callTool("quote")).rejects.toThrow(/spendControls/);
    expect(scheme.createPaymentPayload).not.toHaveBeenCalled();
  });

  it("does not sign on a network the client did not register", async () => {
    callTool.mockResolvedValueOnce(asToolError(paymentRequired({ network: "eip155:8453" })));

    await expect(mcp.callTool("quote")).rejects.toThrow(/No network\/scheme registered/);
    expect(scheme.createPaymentPayload).not.toHaveBeenCalled();
  });

  it("applies the cap to a corrective 402 that raises the amount", async () => {
    callTool
      .mockResolvedValueOnce(asToolError(paymentRequired()))
      .mockResolvedValueOnce(asToolError(paymentRequired({ amount: "5000000" })));

    await expect(mcp.callTool("quote")).rejects.toThrow(/spendControls/);
    expect(scheme.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("lets onPaymentRequested reject a corrective 402 that changes payTo", async () => {
    let approvedPayTo: string | undefined;
    mcp = new x402MCPClient(
      { callTool } as unknown as ConstructorParameters<typeof x402MCPClient>[0],
      new x402Client().register(NETWORK, scheme),
      {
        onPaymentRequested: ({ paymentRequired: pr }) => {
          const payTo = pr.accepts[0].payTo;
          approvedPayTo ??= payTo;
          return payTo === approvedPayTo;
        },
      },
    );
    callTool
      .mockResolvedValueOnce(asToolError(paymentRequired()))
      .mockResolvedValueOnce(asToolError(paymentRequired({ payTo: ATTACKER })));

    await expect(mcp.callTool("quote")).rejects.toThrow("Payment request denied");
    expect(scheme.createPaymentPayload).toHaveBeenCalledTimes(1);
  });
});
