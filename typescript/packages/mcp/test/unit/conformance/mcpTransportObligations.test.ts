/**
 * Conformance: the normative statements of the v2 MCP transport binding,
 * asserted against `@x402/mcp`.
 *
 * `specs/transports-v2/mcp.md` carries five RFC-2119 keywords on five lines
 * (2 MUST, 2 REQUIRED, 1 SHOULD). The `(REQUIRED)` markers at `:27` and `:28`
 * name the two formats the `:25` MUST already requires, so they add no
 * obligation beyond it. Three statements are therefore independently
 * observable, and all three are below, each citing the line it comes from.
 *
 * The sibling HTTP and A2A bindings (`specs/transports-v2/http.md`,
 * `a2a.md`) carry none, so MCP is the whole of the transport-level
 * obligation surface today. A keyword grep of `http.md` matches only the
 * `PAYMENT-REQUIRED` header name, not the RFC-2119 term.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { createPaymentWrapper } from "../../../src/server";
import { x402MCPClient, wrapMCPClientWithPayment } from "../../../src";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000",
  asset: "0xtoken",
  payTo: "0xrecipient",
  maxTimeoutSeconds: 60,
  extra: {},
};

const paymentRequired: PaymentRequired = {
  x402Version: 2,
  accepts: [requirements],
  error: "Payment required",
  resource: {
    url: "mcp://tool/test",
    description: "Test tool",
    mimeType: "application/json",
  },
} as PaymentRequired;

const schemeServer = {
  scheme: "exact",
  defaultAssetTransferMethod: "default",
  paymentFlows: {
    default: { supported: ["authorization"] as const, default: "authorization" as const },
  },
};

/**
 * Minimal resource server standing in for the orchestration the wrapper drives.
 *
 * @returns A resource server double exposing the collaborators the wrapper calls.
 */
const buildResourceServer = () => ({
  findMatchingRequirements: vi.fn().mockReturnValue(requirements),
  validateExtensions: vi.fn().mockReturnValue({ valid: true }),
  getRegisteredScheme: vi.fn().mockReturnValue(schemeServer),
  getPaymentFlow: vi.fn().mockReturnValue("authorization"),
  verifyPayment: vi.fn().mockResolvedValue({ isValid: true }),
  settlePayment: vi.fn().mockResolvedValue({ success: true }),
  createPaymentRequiredResponse: vi.fn().mockResolvedValue(paymentRequired),
  createPaymentCancellationDispatcher: vi.fn().mockReturnValue({ cancel: vi.fn() }),
});

describe("MCP transport — server obligations", () => {
  /**
   * Calls a payment-wrapped tool with no payment attached.
   *
   * @returns The wrapped tool's result and the handler it was built around.
   */
  const callWithoutPayment = async () => {
    const paid = createPaymentWrapper(
      buildResourceServer() as unknown as Parameters<typeof createPaymentWrapper>[0],
      { accepts: [requirements] },
    );
    const handler = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    return { result: await paid(handler)({}, {}), handler };
  };

  /**
   * "When a tool requires payment, servers MUST return a tool result with
   * `isError: true` containing the `PaymentRequired` data."
   * (specs/transports-v2/mcp.md:18)
   */
  it("flags the payment-required result as an error and carries the requirements", async () => {
    const { result, handler } = await callWithoutPayment();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(paymentRequired);
    expect(handler).not.toHaveBeenCalled();
  });

  /**
   * "Servers MUST provide the `PaymentRequired` in both formats"
   * — `structuredContent` and a JSON-encoded `content[0].text`.
   * (specs/transports-v2/mcp.md:25)
   *
   * Both halves are asserted, and asserted to agree: a client reading either
   * one has to arrive at the same requirements.
   */
  it("provides the requirements in both wire formats, agreeing", async () => {
    const { result } = await callWithoutPayment();

    expect(result.structuredContent).toEqual(paymentRequired);

    const text = result.content?.[0];
    expect(text?.type).toBe("text");
    expect(JSON.parse(text!.text as string)).toEqual(paymentRequired);

    expect(JSON.parse(text!.text as string)).toEqual(result.structuredContent);
  });
});

describe("MCP transport — client obligations", () => {
  let mcpClient: { callTool: ReturnType<typeof vi.fn> };
  let paymentClient: { createPaymentPayload: ReturnType<typeof vi.fn> };
  let client: x402MCPClient;

  beforeEach(() => {
    mcpClient = { callTool: vi.fn() };
    paymentClient = {
      createPaymentPayload: vi.fn().mockResolvedValue({
        x402Version: 2,
        accepted: requirements,
        payload: { signature: "0x1" },
      }),
      handlePaymentResponse: vi.fn().mockResolvedValue(undefined),
      register: vi.fn().mockReturnThis(),
      registerV1: vi.fn().mockReturnThis(),
    } as never;
    client = new x402MCPClient(
      mcpClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[0],
      paymentClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[1],
    );
  });

  /**
   * "Clients SHOULD prefer `structuredContent` when available, falling back to
   * parsing `content[0].text`." (specs/transports-v2/mcp.md:75)
   *
   * The two formats are deliberately disagreed here — a different `amount` in
   * each — so that which one the client read is observable in the requirements
   * it goes on to pay against. Nothing else distinguishes them.
   */
  it("reads structuredContent in preference to content[0].text", async () => {
    const fromText: PaymentRequired = {
      ...paymentRequired,
      accepts: [{ ...requirements, amount: "999999" }],
    } as PaymentRequired;

    mcpClient.callTool
      .mockResolvedValueOnce({
        isError: true,
        structuredContent: paymentRequired as unknown as Record<string, unknown>,
        content: [{ type: "text", text: JSON.stringify(fromText) }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "paid" }] });

    await client.callTool("paid_tool");

    expect(paymentClient.createPaymentPayload).toHaveBeenCalledWith(paymentRequired);
  });

  /**
   * The other half of :75 — `structuredContent` is optional on the wire, so a
   * client that prefers it must still work without it.
   */
  it("falls back to content[0].text when structuredContent is absent", async () => {
    mcpClient.callTool
      .mockResolvedValueOnce({
        isError: true,
        content: [{ type: "text", text: JSON.stringify(paymentRequired) }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "paid" }] });

    await client.callTool("paid_tool");

    expect(paymentClient.createPaymentPayload).toHaveBeenCalledWith(paymentRequired);
  });
});
