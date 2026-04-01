import { describe, it, expect, beforeEach } from "vitest";
import {
  x402ResourceServer,
  resolveSettlementOverrideAmount,
} from "../../../src/server/x402ResourceServer";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildPaymentPayload,
  buildPaymentRequirements,
  buildSupportedResponse,
  buildVerifyResponse,
  buildSettleResponse,
} from "../../mocks";
import { Network } from "../../../src/types";

describe("x402ResourceServer", () => {
  describe("Construction", () => {
    it("should create default HTTP facilitator client if none provided", () => {
      const server = new x402ResourceServer();

      expect(server).toBeDefined();
    });

    it("should use provided facilitator client", () => {
      const mockClient = new MockFacilitatorClient(buildSupportedResponse());
      const server = new x402ResourceServer(mockClient);

      expect(server).toBeDefined();
    });

    it("should normalize single client to array", async () => {
      const mockClient = new MockFacilitatorClient(buildSupportedResponse());
      const server = new x402ResourceServer(mockClient);

      await server.initialize();

      expect(mockClient.getSupportedCalls).toBe(1);
    });

    it("should use array of facilitator clients", async () => {
      const mockClient1 = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "scheme1", network: "network1" as Network }],
        }),
      );
      const mockClient2 = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "scheme2", network: "network2" as Network }],
        }),
      );

      const server = new x402ResourceServer([mockClient1, mockClient2]);
      await server.initialize();

      expect(mockClient1.getSupportedCalls).toBe(1);
      expect(mockClient2.getSupportedCalls).toBe(1);
    });

    it("should create default client if empty array provided", async () => {
      const server = new x402ResourceServer([]);

      // Should not throw - uses default client
      await expect(server.initialize()).resolves.not.toThrow();
    });
  });

  describe("register", () => {
    it("should register scheme for network", () => {
      const server = new x402ResourceServer();
      const mockScheme = new MockSchemeNetworkServer("test-scheme");

      const result = server.register("test:network" as Network, mockScheme);

      expect(result).toBe(server); // Chaining
    });

    it("should support multiple schemes per network", () => {
      const server = new x402ResourceServer();
      const scheme1 = new MockSchemeNetworkServer("scheme1");
      const scheme2 = new MockSchemeNetworkServer("scheme2");

      const result = server
        .register("test:network" as Network, scheme1)
        .register("test:network" as Network, scheme2);

      expect(result).toBe(server);
    });

    it("should not override existing scheme registration", () => {
      const server = new x402ResourceServer();
      const firstScheme = new MockSchemeNetworkServer("test-scheme");
      const secondScheme = new MockSchemeNetworkServer("test-scheme");

      server
        .register("test:network" as Network, firstScheme)
        .register("test:network" as Network, secondScheme);

      // This is verified implicitly - both registrations succeed without error
      expect(server).toBeDefined();
    });
  });

  describe("initialize", () => {
    it("should fetch supported kinds from all facilitators", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
      );

      const server = new x402ResourceServer(mockClient);

      await server.initialize();

      expect(mockClient.getSupportedCalls).toBe(1);
    });

    it("should build version/network/scheme mappings", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
      );

      const server = new x402ResourceServer(mockClient);
      const mockScheme = new MockSchemeNetworkServer("exact");
      server.register("eip155:8453" as Network, mockScheme);

      await server.initialize();

      // Should be able to get supported kind
      const supportedKind = server.getSupportedKind(2, "eip155:8453" as Network, "exact");
      expect(supportedKind).toBeDefined();
      expect(supportedKind?.scheme).toBe("exact");
    });

    it("should give precedence to earlier facilitators", async () => {
      const mockClient1 = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: "eip155:8453" as Network,
              extra: { facilitator: "first" },
            },
          ],
        }),
      );

      const mockClient2 = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: "eip155:8453" as Network,
              extra: { facilitator: "second" },
            },
          ],
        }),
      );

      const server = new x402ResourceServer([mockClient1, mockClient2]);

      await server.initialize();

      const supportedKind = server.getSupportedKind(2, "eip155:8453" as Network, "exact");
      expect(supportedKind?.extra?.facilitator).toBe("first");
    });

    it("should continue if one facilitator fails", async () => {
      const failingClient = new MockFacilitatorClient(buildSupportedResponse());
      failingClient.setVerifyResponse(new Error("Network error"));

      const workingClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
      );

      // Mock getSupported to throw for first client
      failingClient.getSupported = async () => {
        throw new Error("Network error");
      };

      const server = new x402ResourceServer([failingClient, workingClient]);

      // Should not throw - continues with working client
      await server.initialize();

      expect(workingClient.getSupportedCalls).toBe(1);
    });

    it("should throw if all facilitators fail", async () => {
      const failingClient1 = new MockFacilitatorClient(buildSupportedResponse());
      failingClient1.getSupported = async () => {
        throw new Error("Network error");
      };

      const failingClient2 = new MockFacilitatorClient(buildSupportedResponse());
      failingClient2.getSupported = async () => {
        throw new Error("Rate limited");
      };

      const server = new x402ResourceServer([failingClient1, failingClient2]);

      await expect(server.initialize()).rejects.toThrow(
        "Failed to initialize: no supported payment kinds loaded from any facilitator",
      );
    });

    it("should clear existing mappings on re-initialization", async () => {
      const mockClient1 = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: "eip155:8453" as Network,
              extra: { version: 1 },
            },
          ],
        }),
      );

      const server = new x402ResourceServer(mockClient1);

      await server.initialize();

      // Re-initialize - this tests the clear logic
      await server.initialize();

      // Mappings should be re-built
      expect(mockClient1.getSupportedCalls).toBe(2);
    });
  });

  describe("buildPaymentRequirements", () => {
    it("should build requirements from ResourceConfig", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "test-scheme", network: "test:network" as Network }],
        }),
      );

      const server = new x402ResourceServer(mockClient);
      const mockScheme = new MockSchemeNetworkServer("test-scheme", {
        amount: "1000000",
        asset: "USDC",
        extra: {},
      });

      server.register("test:network" as Network, mockScheme);
      await server.initialize();

      const requirements = await server.buildPaymentRequirements({
        scheme: "test-scheme",
        payTo: "recipient_address",
        price: "$1.00",
        network: "test:network" as Network,
      });

      expect(requirements).toHaveLength(1);
      expect(requirements[0].scheme).toBe("test-scheme");
      expect(requirements[0].payTo).toBe("recipient_address");
      expect(requirements[0].amount).toBe("1000000");
      expect(requirements[0].asset).toBe("USDC");
    });

    it("should call scheme's parsePrice method", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "test-scheme", network: "test:network" as Network }],
        }),
      );

      const server = new x402ResourceServer(mockClient);
      const mockScheme = new MockSchemeNetworkServer("test-scheme");

      server.register("test:network" as Network, mockScheme);
      await server.initialize();

      await server.buildPaymentRequirements({
        scheme: "test-scheme",
        payTo: "recipient",
        price: "$5.00",
        network: "test:network" as Network,
      });

      expect(mockScheme.parsePriceCalls.length).toBe(1);
      expect(mockScheme.parsePriceCalls[0].price).toBe("$5.00");
      expect(mockScheme.parsePriceCalls[0].network).toBe("test:network");
    });

    it("should call enhancePaymentRequirements", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "test-scheme", network: "test:network" as Network }],
          extensions: ["test-extension"],
        }),
      );

      const server = new x402ResourceServer(mockClient);
      const mockScheme = new MockSchemeNetworkServer("test-scheme");

      server.register("test:network" as Network, mockScheme);
      await server.initialize();

      await server.buildPaymentRequirements({
        scheme: "test-scheme",
        payTo: "recipient",
        price: 1.0,
        network: "test:network" as Network,
      });

      expect(mockScheme.enhanceCalls.length).toBe(1);
    });

    it("should use default maxTimeoutSeconds of 300", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "test-scheme", network: "test:network" as Network }],
        }),
      );

      const server = new x402ResourceServer(mockClient);
      const mockScheme = new MockSchemeNetworkServer("test-scheme");

      server.register("test:network" as Network, mockScheme);
      await server.initialize();

      const requirements = await server.buildPaymentRequirements({
        scheme: "test-scheme",
        payTo: "recipient",
        price: 1.0,
        network: "test:network" as Network,
      });

      expect(requirements[0].maxTimeoutSeconds).toBe(300);
    });

    it("should respect custom maxTimeoutSeconds", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "test-scheme", network: "test:network" as Network }],
        }),
      );

      const server = new x402ResourceServer(mockClient);
      const mockScheme = new MockSchemeNetworkServer("test-scheme");

      server.register("test:network" as Network, mockScheme);
      await server.initialize();

      const requirements = await server.buildPaymentRequirements({
        scheme: "test-scheme",
        payTo: "recipient",
        price: 1.0,
        network: "test:network" as Network,
        maxTimeoutSeconds: 600,
      });

      expect(requirements[0].maxTimeoutSeconds).toBe(600);
    });

    it("should return empty array if no scheme registered for network", async () => {
      const server = new x402ResourceServer();

      const requirements = await server.buildPaymentRequirements({
        scheme: "test-scheme",
        payTo: "recipient",
        price: 1.0,
        network: "test:network" as Network,
      });

      // Current implementation returns empty array and logs warning
      expect(requirements).toEqual([]);
    });

    it("should throw if facilitator doesn't support scheme/network", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "other-scheme", network: "test:network" as Network }],
        }),
      );

      const server = new x402ResourceServer(mockClient);
      const mockScheme = new MockSchemeNetworkServer("test-scheme");

      server.register("test:network" as Network, mockScheme);
      await server.initialize();

      await expect(
        async () =>
          await server.buildPaymentRequirements({
            scheme: "test-scheme",
            payTo: "recipient",
            price: 1.0,
            network: "test:network" as Network,
          }),
      ).rejects.toThrow("Facilitator does not support test-scheme on test:network");
    });
  });

  describe("Lifecycle hooks", () => {
    let server: x402ResourceServer;
    let mockClient: MockFacilitatorClient;

    beforeEach(() => {
      mockClient = new MockFacilitatorClient(
        buildSupportedResponse(),
        buildVerifyResponse({ isValid: true }),
        buildSettleResponse({ success: true }),
      );
      server = new x402ResourceServer(mockClient);
    });

    describe("onBeforeVerify", () => {
      it("should execute hook before verification", async () => {
        let hookExecuted = false;

        server.onBeforeVerify(async context => {
          hookExecuted = true;
          expect(context.paymentPayload).toBeDefined();
          expect(context.requirements).toBeDefined();
        });

        const payload = buildPaymentPayload();
        const requirements = buildPaymentRequirements();

        await server.verifyPayment(payload, requirements);

        expect(hookExecuted).toBe(true);
      });

      it("should abort verification if hook returns abort", async () => {
        server.onBeforeVerify(async () => {
          return { abort: true, reason: "Rate limited" };
        });

        const payload = buildPaymentPayload();
        const requirements = buildPaymentRequirements();

        const result = await server.verifyPayment(payload, requirements);

        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("Rate limited");
        expect(mockClient.verifyCalls.length).toBe(0); // Facilitator not called
      });

      it("should execute multiple hooks in order", async () => {
        const executionOrder: number[] = [];

        server
          .onBeforeVerify(async () => {
            executionOrder.push(1);
          })
          .onBeforeVerify(async () => {
            executionOrder.push(2);
          })
          .onBeforeVerify(async () => {
            executionOrder.push(3);
          });

        await server.verifyPayment(buildPaymentPayload(), buildPaymentRequirements());

        expect(executionOrder).toEqual([1, 2, 3]);
      });

      it("should stop on first abort", async () => {
        const executionOrder: number[] = [];

        server
          .onBeforeVerify(async () => {
            executionOrder.push(1);
          })
          .onBeforeVerify(async () => {
            executionOrder.push(2);
            return { abort: true, reason: "Aborted" };
          })
          .onBeforeVerify(async () => {
            executionOrder.push(3); // Should not execute
          });

        await server.verifyPayment(buildPaymentPayload(), buildPaymentRequirements());

        expect(executionOrder).toEqual([1, 2]); // Third hook not executed
      });
    });

    describe("onAfterVerify", () => {
      it("should execute hook after successful verification", async () => {
        let hookExecuted = false;
        let hookResult: any;

        server.onAfterVerify(async context => {
          hookExecuted = true;
          hookResult = context.result;
        });

        const result = await server.verifyPayment(
          buildPaymentPayload(),
          buildPaymentRequirements(),
        );

        expect(hookExecuted).toBe(true);
        expect(hookResult).toBe(result);
      });

      it("should execute multiple afterVerify hooks in order", async () => {
        const executionOrder: number[] = [];

        server
          .onAfterVerify(async () => {
            executionOrder.push(1);
          })
          .onAfterVerify(async () => {
            executionOrder.push(2);
          })
          .onAfterVerify(async () => {
            executionOrder.push(3);
          });

        await server.verifyPayment(buildPaymentPayload(), buildPaymentRequirements());

        expect(executionOrder).toEqual([1, 2, 3]);
      });

      it("should not execute afterVerify if verification aborted", async () => {
        let afterVerifyCalled = false;

        server.onBeforeVerify(async () => {
          return { abort: true, reason: "Aborted" };
        });

        server.onAfterVerify(async () => {
          afterVerifyCalled = true;
        });

        await server.verifyPayment(buildPaymentPayload(), buildPaymentRequirements());

        expect(afterVerifyCalled).toBe(false);
      });
    });

    describe("onVerifyFailure", () => {
      it("should execute when verification fails", async () => {
        let hookExecuted = false;
        let hookError: Error | undefined;

        mockClient.setVerifyResponse(new Error("Verification failed"));

        server.onVerifyFailure(async context => {
          hookExecuted = true;
          hookError = context.error;
        });

        await expect(
          async () => await server.verifyPayment(buildPaymentPayload(), buildPaymentRequirements()),
        ).rejects.toThrow("Verification failed");

        expect(hookExecuted).toBe(true);
        expect(hookError?.message).toBe("Verification failed");
      });

      it("should allow recovery from failure", async () => {
        mockClient.setVerifyResponse(new Error("Temporary failure"));

        server.onVerifyFailure(async _context => {
          // Recover with successful result
          return {
            recovered: true,
            result: { isValid: true, payer: "0xRecovered" },
          };
        });

        const result = await server.verifyPayment(
          buildPaymentPayload(),
          buildPaymentRequirements(),
        );

        expect(result.isValid).toBe(true);
        expect(result.payer).toBe("0xRecovered");
      });

      it("should try all hooks until one recovers", async () => {
        const executionOrder: number[] = [];

        mockClient.setVerifyResponse(new Error("Failure"));

        server
          .onVerifyFailure(async () => {
            executionOrder.push(1);
            // No recovery
          })
          .onVerifyFailure(async () => {
            executionOrder.push(2);
            return { recovered: true, result: { isValid: true } };
          })
          .onVerifyFailure(async () => {
            executionOrder.push(3); // Should not execute
          });

        await server.verifyPayment(buildPaymentPayload(), buildPaymentRequirements());

        expect(executionOrder).toEqual([1, 2]); // Stops after recovery
      });

      it("should re-throw if no recovery", async () => {
        mockClient.setVerifyResponse(new Error("Fatal error"));

        server.onVerifyFailure(async () => {
          // No recovery
        });

        await expect(
          async () => await server.verifyPayment(buildPaymentPayload(), buildPaymentRequirements()),
        ).rejects.toThrow("Fatal error");
      });
    });

    describe("onBeforeSettle", () => {
      it("should execute hook before settlement", async () => {
        let hookExecuted = false;

        server.onBeforeSettle(async context => {
          hookExecuted = true;
          expect(context.paymentPayload).toBeDefined();
          expect(context.requirements).toBeDefined();
        });

        await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

        expect(hookExecuted).toBe(true);
      });

      it("should abort settlement if hook returns abort", async () => {
        server.onBeforeSettle(async () => {
          return { abort: true, reason: "Insufficient balance" };
        });

        await expect(
          async () => await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements()),
        ).rejects.toThrow("Insufficient balance");

        expect(mockClient.settleCalls.length).toBe(0); // Facilitator not called
      });

      it("should preserve abort reason as errorReason in SettleError", async () => {
        server.onBeforeSettle(async () => {
          return { abort: true, reason: "Insufficient balance", message: "Not enough funds" };
        });

        try {
          await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());
          expect.unreachable("Should have thrown");
        } catch (error: any) {
          expect(error.name).toBe("SettleError");
          expect(error.errorReason).toBe("Insufficient balance");
          expect(error.errorMessage).toBe("Not enough funds");
        }
      });

      it("should wrap unexpected hook errors as before_settle_hook_error", async () => {
        server.onBeforeSettle(async () => {
          throw new Error("Unexpected failure");
        });

        try {
          await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());
          expect.unreachable("Should have thrown");
        } catch (error: any) {
          expect(error.name).toBe("SettleError");
          expect(error.errorReason).toBe("before_settle_hook_error");
          expect(error.errorMessage).toBe("Unexpected failure");
        }
      });

      it("should execute multiple hooks in order", async () => {
        const executionOrder: number[] = [];

        server
          .onBeforeSettle(async () => {
            executionOrder.push(1);
          })
          .onBeforeSettle(async () => {
            executionOrder.push(2);
          });

        await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

        expect(executionOrder).toEqual([1, 2]);
      });
    });

    describe("onAfterSettle", () => {
      it("should execute hook after successful settlement", async () => {
        let hookExecuted = false;
        let hookResult: any;

        server.onAfterSettle(async context => {
          hookExecuted = true;
          hookResult = context.result;
        });

        const result = await server.settlePayment(
          buildPaymentPayload(),
          buildPaymentRequirements(),
        );

        expect(hookExecuted).toBe(true);
        expect(hookResult).toBe(result);
      });
    });

    describe("onSettleFailure", () => {
      it("should execute when settlement fails", async () => {
        let hookExecuted = false;

        mockClient.setSettleResponse(new Error("Settlement failed"));

        server.onSettleFailure(async context => {
          hookExecuted = true;
          expect(context.error.message).toBe("Settlement failed");
        });

        await expect(
          async () => await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements()),
        ).rejects.toThrow();

        expect(hookExecuted).toBe(true);
      });

      it("should allow recovery from failure", async () => {
        mockClient.setSettleResponse(new Error("Temporary failure"));

        server.onSettleFailure(async () => {
          return {
            recovered: true,
            result: {
              success: true,
              transaction: "0xRecoveredTx",
              network: "eip155:8453",
            },
          };
        });

        const result = await server.settlePayment(
          buildPaymentPayload(),
          buildPaymentRequirements(),
        );

        expect(result.success).toBe(true);
        expect(result.transaction).toBe("0xRecoveredTx");
      });
    });
  });

  describe("verifyPayment", () => {
    it("should verify payment through facilitator client", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        buildVerifyResponse({ isValid: true }),
      );

      const server = new x402ResourceServer(mockClient);

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      const result = await server.verifyPayment(payload, requirements);

      expect(result.isValid).toBe(true);
      expect(mockClient.verifyCalls.length).toBe(1);
    });

    it("should throw if no facilitator found", async () => {
      // Create server with mock that throws an error
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse(),
        new Error("No facilitator supports this payment"),
      );

      const server = new x402ResourceServer(mockClient);

      await expect(
        async () =>
          await server.verifyPayment(
            buildPaymentPayload(),
            buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
          ),
      ).rejects.toThrow("No facilitator supports");
    });
  });

  describe("settlePayment", () => {
    it("should settle payment through facilitator client", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true }),
      );

      const server = new x402ResourceServer(mockClient);

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      const result = await server.settlePayment(payload, requirements);

      expect(result.success).toBe(true);
      expect(mockClient.settleCalls.length).toBe(1);
    });

    it("should use original amount when no overrides provided", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true }),
      );

      const server = new x402ResourceServer(mockClient);

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
      });

      await server.settlePayment(payload, requirements);

      expect(mockClient.settleCalls[0].requirements.amount).toBe("1000000");
    });

    it("should override amount when settlementOverrides.amount is provided", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true }),
      );

      const server = new x402ResourceServer(mockClient);

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
      });

      await server.settlePayment(payload, requirements, undefined, undefined, { amount: "500000" });

      // Facilitator should receive the overridden amount
      expect(mockClient.settleCalls[0].requirements.amount).toBe("500000");
    });

    it("should not mutate original requirements when overrides applied", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true }),
      );

      const server = new x402ResourceServer(mockClient);

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
      });

      await server.settlePayment(payload, requirements, undefined, undefined, { amount: "250000" });

      // Original requirements must not be mutated
      expect(requirements.amount).toBe("1000000");
    });

    it("should use original amount when overrides has undefined amount", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true }),
      );

      const server = new x402ResourceServer(mockClient);

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
      });

      await server.settlePayment(payload, requirements, undefined, undefined, {});

      expect(mockClient.settleCalls[0].requirements.amount).toBe("1000000");
    });

    it("should allow settling for zero amount", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true }),
      );

      const server = new x402ResourceServer(mockClient);

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
      });

      await server.settlePayment(payload, requirements, undefined, undefined, { amount: "0" });

      expect(mockClient.settleCalls[0].requirements.amount).toBe("0");
    });

    it("should resolve percent override through settlePayment", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true }),
      );

      const server = new x402ResourceServer(mockClient);
      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "2000",
      });

      await server.settlePayment(payload, requirements, undefined, undefined, { amount: "50%" });

      expect(mockClient.settleCalls[0].requirements.amount).toBe("1000");
    });

    it("should resolve dollar override through settlePayment with default decimals", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true }),
      );

      const server = new x402ResourceServer(mockClient);
      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
      });

      await server.settlePayment(payload, requirements, undefined, undefined, { amount: "$0.001" });

      expect(mockClient.settleCalls[0].requirements.amount).toBe("1000");
    });

    it("should resolve dollar override using scheme getAssetDecimals", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true }),
      );

      const server = new x402ResourceServer(mockClient);
      const mockScheme = new MockSchemeNetworkServer("exact");
      mockScheme.setAssetDecimalsResult(8);
      server.register("eip155:8453" as Network, mockScheme);

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
      });

      await server.settlePayment(payload, requirements, undefined, undefined, { amount: "$0.05" });

      expect(mockClient.settleCalls[0].requirements.amount).toBe("5000000");
    });

    it("should not mutate asset when dollar override is used", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true }),
      );

      const server = new x402ResourceServer(mockClient);
      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
        asset: "0xOriginalToken",
      });

      await server.settlePayment(payload, requirements, undefined, undefined, {
        amount: "$0.10",
      });

      // Only amount changes, asset stays the same
      expect(mockClient.settleCalls[0].requirements.amount).toBe("100000");
      expect(mockClient.settleCalls[0].requirements.asset).toBe("0xOriginalToken");
    });

    it("should pass overridden requirements to beforeSettle hooks", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse(),
        buildVerifyResponse({ isValid: true }),
        buildSettleResponse({ success: true }),
      );

      const server = new x402ResourceServer(mockClient);

      let hookAmount: string | undefined;
      server.onBeforeSettle(async context => {
        hookAmount = context.requirements.amount;
      });

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({ amount: "1000000" });

      await server.settlePayment(payload, requirements, undefined, undefined, { amount: "300000" });

      expect(hookAmount).toBe("300000");
    });
  });

  describe("findMatchingRequirements", () => {
    it("should match v2 requirements by deep equality", () => {
      const server = new x402ResourceServer();

      const req1 = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
        asset: "USDC",
      });

      const req2 = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "2000000",
        asset: "USDC",
      });

      const payload = buildPaymentPayload({
        x402Version: 2,
        accepted: req1,
      });

      const result = server.findMatchingRequirements([req1, req2], payload);

      expect(result).toEqual(req1);
    });

    it("should match v1 requirements by scheme and network", () => {
      const server = new x402ResourceServer();

      const req1 = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
      });

      const payload = buildPaymentPayload({
        x402Version: 1,
        accepted: buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
          amount: "9999999", // Different amount - should still match for v1
        }),
      });

      const result = server.findMatchingRequirements([req1], payload);

      expect(result).toEqual(req1);
    });

    it("should return undefined if no match found", () => {
      const server = new x402ResourceServer();

      const req1 = buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network });
      const payload = buildPaymentPayload({
        accepted: buildPaymentRequirements({ scheme: "intent", network: "eip155:8453" as Network }),
      });

      const result = server.findMatchingRequirements([req1], payload);

      expect(result).toBeUndefined();
    });

    it("should handle objects with different property order (v2)", () => {
      const server = new x402ResourceServer();

      const req = {
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
        asset: "USDC",
        payTo: "0xabc",
        maxTimeoutSeconds: 300,
        extra: {},
      };

      // Same data, different order
      const accepted = {
        extra: {},
        maxTimeoutSeconds: 300,
        payTo: "0xabc",
        asset: "USDC",
        amount: "1000000",
        network: "eip155:8453" as Network,
        scheme: "exact",
      };

      const payload = buildPaymentPayload({ x402Version: 2, accepted });

      const result = server.findMatchingRequirements([req], payload);

      expect(result).toBeDefined();
    });
  });

  describe("createPaymentRequiredResponse", () => {
    it("should create v2 response", async () => {
      const server = new x402ResourceServer();

      const requirements = [buildPaymentRequirements()];
      const resourceInfo = {
        url: "https://example.com",
        description: "Test resource",
        mimeType: "application/json",
      };

      const result = await server.createPaymentRequiredResponse(requirements, resourceInfo);

      expect(result.x402Version).toBe(2);
      expect(result.resource).toEqual(resourceInfo);
      expect(result.accepts).toEqual(requirements);
    });

    it("should include error message if provided", async () => {
      const server = new x402ResourceServer();

      const result = await server.createPaymentRequiredResponse(
        [buildPaymentRequirements()],
        { url: "https://example.com", description: "", mimeType: "" },
        "Payment required",
      );

      expect(result.error).toBe("Payment required");
    });

    it("should include extensions if provided", async () => {
      const server = new x402ResourceServer();

      const result = await server.createPaymentRequiredResponse(
        [buildPaymentRequirements()],
        { url: "https://example.com", description: "", mimeType: "" },
        undefined,
        { bazaar: true, customExt: "value" },
      );

      expect(result.extensions).toEqual({ bazaar: true, customExt: "value" });
    });

    it("should omit extensions if empty", async () => {
      const server = new x402ResourceServer();

      const result = await server.createPaymentRequiredResponse(
        [buildPaymentRequirements()],
        { url: "https://example.com", description: "", mimeType: "" },
        undefined,
        {},
      );

      expect(result.extensions).toBeUndefined();
    });
  });

  describe("getSupportedKind and getFacilitatorExtensions", () => {
    it("should return supported kind after initialization", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: "eip155:8453" as Network,
              extra: { test: true },
            },
          ],
        }),
      );

      const server = new x402ResourceServer(mockClient);
      await server.initialize();

      const supportedKind = server.getSupportedKind(2, "eip155:8453" as Network, "exact");

      expect(supportedKind).toBeDefined();
      expect(supportedKind?.scheme).toBe("exact");
      expect(supportedKind?.extra?.test).toBe(true);
    });

    it("should return undefined if not found", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
      );

      const server = new x402ResourceServer(mockClient);
      await server.initialize();

      const supportedKind = server.getSupportedKind(2, "solana:mainnet" as Network, "exact");

      expect(supportedKind).toBeUndefined();
    });

    it("should return facilitator extensions", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
          extensions: ["bazaar", "sign_in_with_x"],
        }),
      );

      const server = new x402ResourceServer(mockClient);
      await server.initialize();

      const extensions = server.getFacilitatorExtensions(2, "eip155:8453" as Network, "exact");

      expect(extensions).toEqual(["bazaar", "sign_in_with_x"]);
    });

    it("should return empty array if no extensions", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
      );

      const server = new x402ResourceServer(mockClient);
      await server.initialize();

      const extensions = server.getFacilitatorExtensions(2, "eip155:8453" as Network, "exact");

      expect(extensions).toEqual([]);
    });
  });
});

describe("resolveSettlementOverrideAmount", () => {
  const baseRequirements = buildPaymentRequirements({ amount: "2000" });

  describe("raw atomic units", () => {
    it("passes through a plain numeric string unchanged", () => {
      expect(resolveSettlementOverrideAmount("1000", baseRequirements)).toBe("1000");
    });

    it("passes through '0'", () => {
      expect(resolveSettlementOverrideAmount("0", baseRequirements)).toBe("0");
    });
  });

  describe("percent format", () => {
    it("resolves '50%' to half of requirements.amount", () => {
      expect(resolveSettlementOverrideAmount("50%", baseRequirements)).toBe("1000");
    });

    it("resolves '100%' to the full requirements.amount", () => {
      expect(resolveSettlementOverrideAmount("100%", baseRequirements)).toBe("2000");
    });

    it("resolves '0%' to 0", () => {
      expect(resolveSettlementOverrideAmount("0%", baseRequirements)).toBe("0");
    });

    it("resolves '25%' correctly", () => {
      expect(resolveSettlementOverrideAmount("25%", baseRequirements)).toBe("500");
    });

    it("resolves '33.33%' and floors to nearest atomic unit", () => {
      const reqs = buildPaymentRequirements({ amount: "3000" });
      // 3000 * 3333 / 10000 = 999.9 → floored to 999
      expect(resolveSettlementOverrideAmount("33.33%", reqs)).toBe("999");
    });

    it("resolves '10.5%' correctly", () => {
      const reqs = buildPaymentRequirements({ amount: "1000" });
      // 1000 * 1050 / 10000 = 105
      expect(resolveSettlementOverrideAmount("10.5%", reqs)).toBe("105");
    });
  });

  describe("dollar price format", () => {
    it("converts '$1.00' using default 6 decimals", () => {
      expect(resolveSettlementOverrideAmount("$1.00", baseRequirements)).toBe("1000000");
    });

    it("converts '$0.05' using default 6 decimals", () => {
      expect(resolveSettlementOverrideAmount("$0.05", baseRequirements)).toBe("50000");
    });

    it("converts '$0.05' using 8 decimals when provided", () => {
      expect(resolveSettlementOverrideAmount("$0.05", baseRequirements, 8)).toBe("5000000");
    });

    it("converts '$0.001' using default 6 decimals", () => {
      expect(resolveSettlementOverrideAmount("$0.001", baseRequirements)).toBe("1000");
    });

    it("converts '$0' to '0'", () => {
      expect(resolveSettlementOverrideAmount("$0", baseRequirements)).toBe("0");
    });
  });
});
