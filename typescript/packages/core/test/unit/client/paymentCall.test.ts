// Regression cases for per-call payment context (#3750). Adapted from the
// reference cases shared by @epistemedeus on the issue.
import { describe, expect, it } from "vitest";
import { x402Client, x402HTTPClient } from "../../../src/client";
import {
  MockSchemeNetworkClient,
  buildPaymentRequired,
  buildPaymentRequirements,
} from "../../mocks";
import type {
  Network,
  PaymentCall,
  PaymentPayloadContext,
  PaymentRequired,
} from "../../../src/types";
import type { SchemeNetworkClient } from "../../../src/types/mechanisms";

const network = "test:network" as Network;

/**
 * Builds a PaymentRequired with one test accept.
 *
 * @param amount - Atomic amount
 * @returns The PaymentRequired
 */
function required(amount = "1000000"): PaymentRequired {
  return buildPaymentRequired({
    accepts: [
      buildPaymentRequirements({
        scheme: "test-scheme",
        network,
        amount,
        payTo: "test_recipient",
      }),
    ],
  });
}

/**
 * Builds createPaymentPayload options for an HTTP call.
 *
 * @param url - Request URL
 * @param headers - Request headers
 * @returns The options
 */
function httpCall(
  url: string,
  headers: Record<string, string> = { "x-request-id": "req" },
): { call: PaymentCall } {
  return { call: { kind: "http", method: "POST", url, headers } };
}

/**
 * A minimal scheme payload result.
 *
 * @returns The payload result
 */
function payload() {
  return { x402Version: 2, payload: { signature: "scheme_signature" } };
}

/**
 * Polls until a condition holds.
 *
 * @param ready - Condition
 */
async function waitFor(ready: () => boolean): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 1000) {
      throw new Error("timed out waiting for concurrent calls");
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("per-call payment context", () => {
  it("keeps concurrent HTTP calls on one client bound to their own call", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let waiting = 0;
    const seen: string[] = [];
    const scheme: SchemeNetworkClient = {
      scheme: "test-scheme",
      async createPaymentPayload(_version, requirements, context) {
        if (context?.call?.kind !== "http") {
          throw new Error("request_context_missing");
        }
        const url = context.call.url;
        expect(requirements.payTo).toBe("test_recipient");
        waiting += 1;
        await gate;
        seen.push(url);
        return payload();
      },
    };
    const client = new x402Client().register(network, scheme).setSpendControls(false);
    const first = client.createPaymentPayload(required(), httpCall("https://pay.example/a"));
    const second = client.createPaymentPayload(required(), httpCall("https://pay.example/b"));
    await waitFor(() => waiting === 2);
    release();
    const results = await Promise.all([first, second]);

    expect(seen.sort()).toEqual(["https://pay.example/a", "https://pay.example/b"]);
    for (const result of results) {
      expect(result.accepted.payTo).toBe("test_recipient");
      expect(JSON.stringify(result)).not.toContain("pay.example");
      expect(JSON.stringify(result)).not.toContain("x-request-id");
    }
  });

  it("leaves callers without a call unchanged", async () => {
    const seen: Array<PaymentPayloadContext | undefined> = [];
    const scheme: SchemeNetworkClient = {
      scheme: "test-scheme",
      async createPaymentPayload(_version, _requirements, context) {
        seen.push(context);
        return payload();
      },
    };
    const client = new x402Client().register(network, scheme).setSpendControls(false);

    await client.createPaymentPayload(required());
    await client.createPaymentPayload(required(), {});
    await client.createPaymentPayload(required(), { call: undefined });
    const withCall = await client.createPaymentPayload(
      required(),
      httpCall("https://pay.example/legacy"),
    );

    expect(seen.slice(0, 3).map(context => context && "call" in context)).toEqual([
      false,
      false,
      false,
    ]);
    expect(seen[3]?.call?.kind).toBe("http");
    expect(withCall.payload).toEqual({ signature: "scheme_signature" });
  });

  it("shows hooks the call without letting it choose the payee, amount or network", async () => {
    let hookUrl = "";
    const scheme: SchemeNetworkClient = {
      scheme: "test-scheme",
      async createPaymentPayload(_version, requirements, context) {
        expect(requirements.payTo).toBe("test_recipient");
        expect(requirements.amount).toBe("1000000");
        expect(requirements.network).toBe(network);
        expect(context?.call?.kind === "http" && context.call.url).toBe(hookUrl);
        return payload();
      },
    };
    const client = new x402Client().register(network, scheme).setSpendControls(false);
    client.onBeforePaymentCreation(async context => {
      if (context.call?.kind !== "http") {
        throw new Error("request_context_missing");
      }
      hookUrl = context.call.url;
      expect(context.call.headers["x-pay-to"]).toBe("attacker");
    });
    let afterSaw: string | undefined;
    client.onAfterPaymentCreation(async context => {
      afterSaw = context.call?.kind;
      expect(context.paymentPayload.accepted.payTo).toBe("test_recipient");
      expect(JSON.stringify(context.paymentPayload)).not.toContain("attacker");
    });

    const result = await client.createPaymentPayload(
      required(),
      httpCall("https://pay.example/hook", { "x-pay-to": "attacker", "x-amount": "999" }),
    );

    expect(hookUrl).toBe("https://pay.example/hook");
    expect(afterSaw).toBe("http");
    expect(result.accepted.amount).toBe("1000000");
    expect(result.accepted.network).toBe(network);
  });

  it("gives the failure hook the call", async () => {
    let seen = "";
    const scheme: SchemeNetworkClient = {
      scheme: "test-scheme",
      async createPaymentPayload() {
        throw new Error("unsupported_call_kind");
      },
    };
    const client = new x402Client().register(network, scheme).setSpendControls(false);
    client.onPaymentCreationFailure(async context => {
      if (context.call?.kind === "mcp") {
        seen = context.call.toolName;
      }
    });
    await expect(
      client.createPaymentPayload(required(), {
        call: { kind: "mcp", toolName: "paid_tool", arguments: { article: "one" } },
      }),
    ).rejects.toThrow("unsupported_call_kind");
    expect(seen).toBe("paid_tool");
  });

  it("still aborts from a hook before the scheme runs", async () => {
    const scheme = new MockSchemeNetworkClient("test-scheme");
    const client = new x402Client().register(network, scheme).setSpendControls(false);
    client.onBeforePaymentCreation(async context => {
      expect(context.call?.kind).toBe("http");
      return { abort: true, reason: "url_policy" };
    });
    await expect(
      client.createPaymentPayload(required(), httpCall("https://pay.example/no")),
    ).rejects.toThrow("Payment creation aborted: url_policy");
    expect(scheme.createPaymentPayloadCalls).toHaveLength(0);
  });

  it("passes the call beside the extensions", async () => {
    const scheme = new MockSchemeNetworkClient("test-scheme");
    const client = new x402Client().register(network, scheme).setSpendControls(false);
    await client.createPaymentPayload(
      buildPaymentRequired({
        extensions: { "cardano-request-commitment": { info: { profile: "http:1" } } },
        accepts: [buildPaymentRequirements({ scheme: "test-scheme", network, amount: "1000000" })],
      }),
      httpCall("https://pay.example/ext"),
    );
    const context = scheme.createPaymentPayloadCalls[0].context;
    expect(context?.extensions).toEqual({
      "cardano-request-commitment": { info: { profile: "http:1" } },
    });
    expect(context?.call?.kind).toBe("http");
  });

  it("does not read the body unless the scheme asks, and never copies it into the payload", async () => {
    let reads = 0;
    const getBody = async () => {
      reads += 1;
      return new Uint8Array([9, 8, 7]);
    };
    const call: PaymentCall = {
      kind: "http",
      method: "POST",
      url: "https://pay.example/body",
      headers: {},
      getBody,
    };

    const quiet = new x402Client()
      .register(network, { scheme: "test-scheme", createPaymentPayload: async () => payload() })
      .setSpendControls(false);
    await quiet.createPaymentPayload(required(), { call });
    expect(reads).toBe(0);

    const reading: SchemeNetworkClient = {
      scheme: "test-scheme",
      async createPaymentPayload(_version, _requirements, context) {
        if (context?.call?.kind !== "http" || !context.call.getBody) {
          throw new Error("request_context_missing");
        }
        expect(await context.call.getBody()).toEqual(new Uint8Array([9, 8, 7]));
        return payload();
      },
    };
    const readingClient = new x402Client().register(network, reading).setSpendControls(false);
    const result = await readingClient.createPaymentPayload(required(), { call });
    expect(reads).toBe(1);
    expect(JSON.stringify(result)).not.toContain("9,8,7");
  });

  it("snapshots MCP arguments per call and keeps them off the payload", async () => {
    const seen: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let waiting = 0;
    const scheme: SchemeNetworkClient = {
      scheme: "test-scheme",
      async createPaymentPayload(_version, _requirements, context) {
        if (context?.call?.kind !== "mcp") {
          throw new Error("unsupported_call_kind");
        }
        expect(Object.isFrozen(context.call.arguments)).toBe(true);
        waiting += 1;
        await gate;
        seen.push(String(context.call.arguments.article));
        return payload();
      },
    };
    const client = new x402Client().register(network, scheme).setSpendControls(false);
    const firstArgs = { article: "one" };
    const first = client.createPaymentPayload(required(), {
      call: { kind: "mcp", toolName: "paid_tool", arguments: firstArgs },
    });
    const second = client.createPaymentPayload(required(), {
      call: { kind: "mcp", toolName: "other_tool", arguments: { article: "two" } },
    });
    await waitFor(() => waiting === 2);
    firstArgs.article = "mutated";
    release();
    const results = await Promise.all([first, second]);
    expect(seen.sort()).toEqual(["one", "two"]);
    expect(JSON.stringify(results)).not.toContain("paid_tool");
  });

  it("forwards the call through x402HTTPClient", async () => {
    const scheme = new MockSchemeNetworkClient("test-scheme");
    const client = new x402Client().register(network, scheme).setSpendControls(false);
    const http = new x402HTTPClient(client);
    await http.createPaymentPayload(required());
    await http.createPaymentPayload(required(), httpCall("https://pay.example/http"));
    expect(scheme.createPaymentPayloadCalls[0].context?.call).toBeUndefined();
    expect(scheme.createPaymentPayloadCalls[1].context?.call).toMatchObject({
      kind: "http",
      method: "POST",
      url: "https://pay.example/http",
    });
  });

  it("normalizes headers: lowercase, no prototype, no payment headers, joined duplicates", async () => {
    const scheme = new MockSchemeNetworkClient("test-scheme");
    const client = new x402Client().register(network, scheme).setSpendControls(false);
    const protoHeaders = JSON.parse('{"__proto__": "polluted", "x-request-id": "id-2"}') as Record<
      string,
      string
    >;

    await client.createPaymentPayload(required(), {
      call: {
        kind: "http",
        method: "GET",
        url: "https://pay.example/headers",
        headers: {
          "X-Request-Id": "id-1",
          "Payment-Signature": "sig",
          "X-Payment": "old",
          "": "skip",
          "x-request-id": "id-3",
        },
      },
    });
    await client.createPaymentPayload(required(), {
      call: {
        kind: "http",
        method: "GET",
        url: "https://pay.example/proto",
        headers: protoHeaders,
      },
    });

    const copied = scheme.createPaymentPayloadCalls[0].context?.call;
    if (copied?.kind !== "http") throw new Error("request_context_missing");
    expect(Object.getPrototypeOf(copied.headers)).toBeNull();
    expect(Object.isFrozen(copied.headers)).toBe(true);
    expect({ ...copied.headers }).toEqual({ "x-request-id": "id-1, id-3" });
    expect(copied.getBody).toBeUndefined();

    const proto = scheme.createPaymentPayloadCalls[1].context?.call;
    if (proto?.kind !== "http") throw new Error("request_context_missing");
    expect(proto.headers["__proto__"]).toBe("polluted");
    expect(proto.headers["x-request-id"]).toBe("id-2");
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  });

  it("rejects a malformed or unsupported call before any hook or signing", async () => {
    const scheme = new MockSchemeNetworkClient("test-scheme");
    const client = new x402Client().register(network, scheme).setSpendControls(false);
    let hookRan = false;
    client.onBeforePaymentCreation(async () => {
      hookRan = true;
    });
    const http = { kind: "http", method: "GET", url: "https://pay.example", headers: {} };
    const rejected = [
      null,
      [],
      { call: null },
      { call: [] },
      { call: { kind: "grpc" } },
      { call: { kind: "http" } },
      { call: { ...http, method: "" } },
      { call: { ...http, url: "" } },
      { call: { ...http, headers: [] } },
      { call: { ...http, headers: { a: 1 } } },
      { call: { ...http, getBody: 1 } },
      { call: { kind: "mcp" } },
      { call: { kind: "mcp", toolName: "" } },
      { call: { kind: "mcp", toolName: "tool", arguments: [] } },
      { call: { kind: "mcp", toolName: "tool", arguments: { fn: () => undefined } } },
    ];
    for (const options of rejected) {
      await expect(client.createPaymentPayload(required(), options as never)).rejects.toThrow(
        /^(invalid_payment_call|unsupported_payment_call_kind)/,
      );
    }
    expect(hookRan).toBe(false);
    expect(scheme.createPaymentPayloadCalls).toHaveLength(0);
  });

  it("passes a v1 scheme the same per-call context", async () => {
    const seen: PaymentPayloadContext[] = [];
    const scheme: SchemeNetworkClient = {
      scheme: "test-scheme",
      async createPaymentPayload(_version, _requirements, context) {
        if (context) seen.push(context);
        return { x402Version: 1, payload: { signature: "v1_signature" } };
      },
    };
    const client = new x402Client().registerV1("base-sepolia", scheme).setSpendControls(false);
    await client.createPaymentPayload(
      buildPaymentRequired({
        x402Version: 1,
        accepts: [
          {
            ...buildPaymentRequirements({
              scheme: "test-scheme",
              network: "base-sepolia" as Network,
            }),
            maxAmountRequired: "1000000",
          } as PaymentRequired["accepts"][number],
        ],
      }),
      httpCall("https://pay.example/v1"),
    );
    expect(seen[0].call?.kind).toBe("http");
  });
});
