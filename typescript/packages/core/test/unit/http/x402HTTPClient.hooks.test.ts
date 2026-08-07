import { describe, it, expect } from "vitest";
import { x402HTTPClient, PaymentRequiredHook } from "../../../src/http/x402HTTPClient";
import { x402Client } from "../../../src/client/x402Client";
import { buildPaymentRequired } from "../../mocks";

describe("x402HTTPClient", () => {
  describe("onPaymentRequired hook", () => {
    it("should return this for chaining", () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      const hook: PaymentRequiredHook = async () => undefined;

      const result = httpClient.onPaymentRequired(hook);

      expect(result).toBe(httpClient);
    });

    it("should allow chaining multiple hooks", () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      const hook1: PaymentRequiredHook = async () => undefined;
      const hook2: PaymentRequiredHook = async () => undefined;

      const result = httpClient.onPaymentRequired(hook1).onPaymentRequired(hook2);

      expect(result).toBe(httpClient);
    });
  });

  describe("handlePaymentRequired", () => {
    it("should return null when no hooks are registered", async () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      const paymentRequired = buildPaymentRequired();

      const result = await httpClient.handlePaymentRequired(paymentRequired);

      expect(result).toBeNull();
    });

    it("should return headers when a hook provides them", async () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      const expectedHeaders = { Authorization: "Bearer token123" };
      const hook: PaymentRequiredHook = async () => ({ headers: expectedHeaders });
      httpClient.onPaymentRequired(hook);

      const paymentRequired = buildPaymentRequired();
      const result = await httpClient.handlePaymentRequired(paymentRequired);

      expect(result).toEqual(expectedHeaders);
    });

    it("should return null when hook returns void", async () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      const hook: PaymentRequiredHook = async () => undefined;
      httpClient.onPaymentRequired(hook);

      const paymentRequired = buildPaymentRequired();
      const result = await httpClient.handlePaymentRequired(paymentRequired);

      expect(result).toBeNull();
    });

    it("should run hooks in order and first to return headers wins", async () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      const executionOrder: number[] = [];

      const hook1: PaymentRequiredHook = async () => {
        executionOrder.push(1);
        return { headers: { "X-Hook": "first" } };
      };
      const hook2: PaymentRequiredHook = async () => {
        executionOrder.push(2);
        return { headers: { "X-Hook": "second" } };
      };

      httpClient.onPaymentRequired(hook1).onPaymentRequired(hook2);

      const paymentRequired = buildPaymentRequired();
      const result = await httpClient.handlePaymentRequired(paymentRequired);

      expect(result).toEqual({ "X-Hook": "first" });
      expect(executionOrder).toEqual([1]); // Second hook should not be called
    });

    it("should skip hooks that return void and continue to next", async () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      const executionOrder: number[] = [];

      const hook1: PaymentRequiredHook = async () => {
        executionOrder.push(1);
        return undefined;
      };
      const hook2: PaymentRequiredHook = async () => {
        executionOrder.push(2);
        return { headers: { "X-Hook": "second" } };
      };

      httpClient.onPaymentRequired(hook1).onPaymentRequired(hook2);

      const paymentRequired = buildPaymentRequired();
      const result = await httpClient.handlePaymentRequired(paymentRequired);

      expect(result).toEqual({ "X-Hook": "second" });
      expect(executionOrder).toEqual([1, 2]);
    });

    it("should pass paymentRequired context to hooks", async () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      const paymentRequired = buildPaymentRequired({
        resource: { url: "https://test.com", description: "Test", mimeType: "text/plain" },
      });

      let receivedContext: unknown;
      const hook: PaymentRequiredHook = async ctx => {
        receivedContext = ctx;
        return undefined;
      };
      httpClient.onPaymentRequired(hook);

      await httpClient.handlePaymentRequired(paymentRequired);

      expect(receivedContext).toEqual({ paymentRequired });
    });

    it("should return null when all hooks return void", async () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);

      const hook1: PaymentRequiredHook = async () => undefined;
      const hook2: PaymentRequiredHook = async () => undefined;

      httpClient.onPaymentRequired(hook1).onPaymentRequired(hook2);

      const paymentRequired = buildPaymentRequired();
      const result = await httpClient.handlePaymentRequired(paymentRequired);

      expect(result).toBeNull();
    });

    it("should run declared extension hooks after manual hooks", async () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      const order: string[] = [];

      httpClient.onPaymentRequired(async () => {
        order.push("manual");
      });
      client.registerExtension({
        key: "httpExtension",
        transportHooks: {
          http: {
            onPaymentRequired: async declaration => {
              order.push("extension");
              expect(declaration).toEqual({ enabled: true });
              return { headers: { "X-Extension": "yes" } };
            },
          },
        },
      });

      const paymentRequired = buildPaymentRequired({
        extensions: { httpExtension: { enabled: true } },
      });
      const result = await httpClient.handlePaymentRequired(paymentRequired);

      expect(result).toEqual({ "X-Extension": "yes" });
      expect(order).toEqual(["manual", "extension"]);
    });

    it("should skip extension hooks when the 402 response does not declare the extension", async () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      let extensionCalled = false;

      client.registerExtension({
        key: "httpExtension",
        transportHooks: {
          http: {
            onPaymentRequired: async () => {
              extensionCalled = true;
              return { headers: { "X-Extension": "yes" } };
            },
          },
        },
      });

      const result = await httpClient.handlePaymentRequired(buildPaymentRequired());

      expect(result).toBeNull();
      expect(extensionCalled).toBe(false);
    });

    it("should stop before extension hooks when a manual hook provides headers", async () => {
      const client = new x402Client();
      const httpClient = new x402HTTPClient(client);
      let extensionCalled = false;

      httpClient.onPaymentRequired(async () => ({ headers: { "X-Manual": "yes" } }));
      client.registerExtension({
        key: "httpExtension",
        transportHooks: {
          http: {
            onPaymentRequired: async () => {
              extensionCalled = true;
              return { headers: { "X-Extension": "yes" } };
            },
          },
        },
      });

      const paymentRequired = buildPaymentRequired({
        extensions: { httpExtension: {} },
      });
      const result = await httpClient.handlePaymentRequired(paymentRequired);

      expect(result).toEqual({ "X-Manual": "yes" });
      expect(extensionCalled).toBe(false);
    });
  });
});
