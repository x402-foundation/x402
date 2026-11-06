import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BeforePaymentCreationHook,
  PaymentCreationContext,
  PaymentCreationFailureContext,
  x402Client,
} from "../../../src/client/x402Client";
import { buildPaymentPayload, buildPaymentRequired, MockSchemeNetworkClient } from "../../mocks";

describe("payment creation hook context", () => {
  const paymentRequired = buildPaymentRequired({ extensions: { budget: {} } });
  let client: x402Client;
  let scheme: MockSchemeNetworkClient;

  beforeEach(() => {
    client = new x402Client();
    scheme = new MockSchemeNetworkClient("test-scheme");
    client.register("test:network", scheme);
  });

  it("shares one context across manual, scheme and extension hooks", async () => {
    const contexts: PaymentCreationContext[] = [];
    const before: BeforePaymentCreationHook = async context => {
      expect(context).not.toHaveProperty("paymentPayload");
      contexts.push(context);
    };
    client.onBeforePaymentCreation(before);
    client.register(
      "test:network",
      new MockSchemeNetworkClient("test-scheme", undefined, {
        onBeforePaymentCreation: before,
        onAfterPaymentCreation: async context => {
          contexts.push(context);
        },
      }),
    );
    client.registerExtension({
      key: "budget",
      hooks: {
        onBeforePaymentCreation: async (_declaration, context) => before(context),
        onAfterPaymentCreation: async (_declaration, context) => {
          contexts.push(context);
        },
      },
    });
    client.onAfterPaymentCreation(async context => {
      contexts.push(context);
    });

    const payload = await client.createPaymentPayload(paymentRequired);

    expect(contexts).toHaveLength(6);
    for (const context of contexts) {
      expect(context).toBe(contexts[0]);
      expect(context.paymentRequired).toBe(paymentRequired);
      expect(context.selectedRequirements).toBe(paymentRequired.accepts[0]);
    }
    expect(contexts[0]).toHaveProperty("paymentPayload", payload);
    expect(payload).not.toHaveProperty("error");
  });

  it("keeps concurrent reservations separate when an after hook throws", async () => {
    const contexts: PaymentCreationContext[] = [];
    const holds = new Set<PaymentCreationContext>();
    const bothStarted = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    const failure = new Error("after hook failed");
    const createPayload = vi.spyOn(scheme, "createPaymentPayload").mockImplementation(async () => {
      const attempt = createPayload.mock.calls.length;
      if (attempt === 2) bothStarted.resolve();
      await bothStarted.promise;
      if (attempt === 2) await releaseSecond.promise;
      return { x402Version: 2, payload: { attempt } };
    });
    client.onBeforePaymentCreation(async context => {
      contexts.push(context);
      holds.add(context);
    });
    client.onAfterPaymentCreation(async context => {
      if (context.paymentPayload.payload.attempt === 1) throw failure;
      expect(holds.delete(context)).toBe(true);
    });
    client.onPaymentCreationFailure(async context => {
      expect(context).toBe(contexts[0]);
      expect(context.error).toBe(failure);
      expect(holds.delete(context)).toBe(true);
    });

    const first = client.createPaymentPayload(paymentRequired);
    const second = client.createPaymentPayload(paymentRequired);
    try {
      await expect(first).rejects.toBe(failure);
      expect(contexts[0]).not.toBe(contexts[1]);
      expect(holds.size).toBe(1);
      expect(holds.has(contexts[1])).toBe(true);
    } finally {
      releaseSecond.resolve();
      await second;
    }
    expect(holds.size).toBe(0);
  });

  describe.each(["manual", "scheme", "extension"] as const)("%s before hook", source => {
    it.each(["abort", "throw"] as const)(
      "releases reservations after %s without recovering",
      async mode => {
        const holds = new Set<PaymentCreationContext>();
        const failures: PaymentCreationFailureContext[] = [];
        const released: boolean[] = [];
        const failure = new Error("approval failed");
        const order: string[] = [];
        const stop: BeforePaymentCreationHook = async () => {
          if (mode === "throw") throw failure;
          return { abort: true, reason: "approval denied" };
        };
        client.onBeforePaymentCreation(async context => {
          holds.add(context);
        });
        if (source === "manual") client.onBeforePaymentCreation(stop);
        client.onBeforePaymentCreation(async () => {
          order.push("later-manual-before");
        });
        client.onPaymentCreationFailure(async () => {
          order.push("manual-failure");
          return { recovered: true, payload: buildPaymentPayload() };
        });
        scheme = new MockSchemeNetworkClient("test-scheme", undefined, {
          onBeforePaymentCreation: source === "scheme" ? stop : undefined,
          onPaymentCreationFailure: async () => {
            order.push("scheme-failure");
            throw new Error("cleanup failed");
          },
        });
        client.register("test:network", scheme);
        client.registerExtension({
          key: "budget",
          hooks: {
            onBeforePaymentCreation:
              source === "extension" ? async (_declaration, context) => stop(context) : undefined,
            onPaymentCreationFailure: async (_declaration, context) => {
              order.push("extension-failure");
              failures.push(context);
              released.push(holds.delete(context));
            },
          },
        });
        const after = vi.fn();
        client.onAfterPaymentCreation(after);

        for (let attempt = 0; attempt < 2; attempt++) {
          const result = client.createPaymentPayload(paymentRequired);
          if (mode === "throw") await expect(result).rejects.toBe(failure);
          else await expect(result).rejects.toThrow("Payment creation aborted: approval denied");
          expect(holds.size).toBe(0);
        }
        const expected = ["manual-failure", "scheme-failure", "extension-failure"];
        if (source !== "manual") expected.unshift("later-manual-before");
        expect(order).toEqual([...expected, ...expected]);
        expect(released).toEqual([true, true]);
        expect(failures).toHaveLength(2);
        for (const context of failures) {
          if (mode === "throw") expect(context.error).toBe(failure);
          else expect(context.error.message).toBe("Payment creation aborted: approval denied");
        }
        expect(scheme.createPaymentPayloadCalls).toHaveLength(0);
        expect(after).not.toHaveBeenCalled();
      },
    );
  });

  it("preserves failure recovery after the before hooks have passed", async () => {
    const failure = new Error("scheme failed");
    const recovered = buildPaymentPayload();
    let beforeContext: PaymentCreationContext | undefined;
    scheme.setPayloadResult(failure);
    client.onBeforePaymentCreation(async context => {
      beforeContext = context;
    });
    client.onPaymentCreationFailure(async context => {
      expect(context).toBe(beforeContext);
      expect(context.error).toBe(failure);
      return { recovered: true, payload: recovered };
    });

    await expect(client.createPaymentPayload(paymentRequired)).resolves.toBe(recovered);
    expect(scheme.createPaymentPayloadCalls).toHaveLength(1);
  });

  it("preserves failure-hook errors after the before hooks have passed", async () => {
    const failure = new Error("recovery failed");
    scheme.setPayloadResult(new Error("scheme failed"));
    client.onPaymentCreationFailure(async () => {
      throw failure;
    });

    await expect(client.createPaymentPayload(paymentRequired)).rejects.toBe(failure);
  });
});
