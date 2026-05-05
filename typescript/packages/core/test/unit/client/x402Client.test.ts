import { describe, it, expect } from "vitest";
import { x402Client } from "../../../src/client/x402Client";
import { PaymentPolicy } from "../../../src/client/x402Client";
import { MockSchemeNetworkClient } from "../../mocks";
import { buildPaymentRequired, buildPaymentRequirements } from "../../mocks";
import { Network, PaymentRequirements } from "../../../src/types";

describe("x402Client", () => {
  describe("Construction", () => {
    it("should create instance with default selector", () => {
      const client = new x402Client();

      expect(client).toBeDefined();
    });

    it("should use custom payment requirements selector", async () => {
      let selectorCalled = false;
      const customSelector = (version: number, reqs: PaymentRequirements[]) => {
        selectorCalled = true;
        return reqs[reqs.length - 1]; // Choose last instead of first
      };

      const client = new x402Client(customSelector);
      const mockClient = new MockSchemeNetworkClient("test-scheme");
      client.register("test:network" as Network, mockClient);

      const paymentRequired = buildPaymentRequired({
        accepts: [
          buildPaymentRequirements({
            scheme: "test-scheme",
            network: "test:network" as Network,
            amount: "100",
          }),
          buildPaymentRequirements({
            scheme: "test-scheme",
            network: "test:network" as Network,
            amount: "200",
          }),
        ],
      });

      await client.createPaymentPayload(paymentRequired);

      expect(selectorCalled).toBe(true);
    });

    it("should use default selector that chooses first requirement", async () => {
      const client = new x402Client();
      const mockClient = new MockSchemeNetworkClient("test-scheme");
      client.register("test:network" as Network, mockClient);

      const firstReq = buildPaymentRequirements({
        scheme: "test-scheme",
        network: "test:network" as Network,
        amount: "100",
      });
      const secondReq = buildPaymentRequirements({
        scheme: "test-scheme",
        network: "test:network" as Network,
        amount: "200",
      });

      const paymentRequired = buildPaymentRequired({
        accepts: [firstReq, secondReq],
      });

      await client.createPaymentPayload(paymentRequired);

      // Should have called createPaymentPayload with first requirement
      expect(mockClient.createPaymentPayloadCalls.length).toBe(1);
      expect(mockClient.createPaymentPayloadCalls[0].requirements).toEqual(firstReq);
    });
  });

  describe("fromConfig", () => {
    it("should create client from config", () => {
      const mockClient1 = new MockSchemeNetworkClient("scheme1");
      const mockClient2 = new MockSchemeNetworkClient("scheme2");

      const client = x402Client.fromConfig({
        schemes: [
          { network: "network1" as Network, client: mockClient1 },
          { network: "network2" as Network, client: mockClient2, x402Version: 1 },
        ],
      });

      expect(client).toBeDefined();
    });

    it("should register v1 schemes correctly", async () => {
      const mockClient = new MockSchemeNetworkClient("v1-scheme", {
        x402Version: 1,
        payload: { signature: "v1_sig" },
      });

      const client = x402Client.fromConfig({
        schemes: [{ network: "base-sepolia" as Network, client: mockClient, x402Version: 1 }],
      });

      const paymentRequired = buildPaymentRequired({
        x402Version: 1,
        accepts: [
          buildPaymentRequirements({
            scheme: "v1-scheme",
            network: "base-sepolia" as Network,
          }),
        ],
      });

      const result = await client.createPaymentPayload(paymentRequired);

      expect(result.x402Version).toBe(1);
    });

    it("should register policies in order", async () => {
      const executionOrder: number[] = [];
      const policy1: PaymentPolicy = (version, reqs) => {
        executionOrder.push(1);
        return reqs;
      };
      const policy2: PaymentPolicy = (version, reqs) => {
        executionOrder.push(2);
        return reqs;
      };

      const mockClient = new MockSchemeNetworkClient("test-scheme");

      const client = x402Client.fromConfig({
        schemes: [{ network: "test:network" as Network, client: mockClient }],
        policies: [policy1, policy2],
      });

      const paymentRequired = buildPaymentRequired({
        accepts: [
          buildPaymentRequirements({ scheme: "test-scheme", network: "test:network" as Network }),
        ],
      });

      await client.createPaymentPayload(paymentRequired);

      expect(executionOrder).toEqual([1, 2]);
    });

    it("should use custom selector from config", async () => {
      let customSelectorCalled = false;
      const customSelector = (version: number, reqs: PaymentRequirements[]) => {
        customSelectorCalled = true;
        return reqs[0];
      };

      const mockClient = new MockSchemeNetworkClient("test-scheme");

      const client = x402Client.fromConfig({
        schemes: [{ network: "test:network" as Network, client: mockClient }],
        paymentRequirementsSelector: customSelector,
      });

      const paymentRequired = buildPaymentRequired({
        accepts: [
          buildPaymentRequirements({ scheme: "test-scheme", network: "test:network" as Network }),
        ],
      });

      await client.createPaymentPayload(paymentRequired);

      expect(customSelectorCalled).toBe(true);
    });
  });

  describe("register", () => {
    it("should register scheme for v2", () => {
      const client = new x402Client();
      const mockClient = new MockSchemeNetworkClient("test-scheme");

      const result = client.register("test:network" as Network, mockClient);

      expect(result).toBe(client); // Chaining
    });

    it("should allow multiple schemes for same network", async () => {
      const client = new x402Client();
      const exactClient = new MockSchemeNetworkClient("exact");
      const intentClient = new MockSchemeNetworkClient("intent");

      client
        .register("eip155:8453" as Network, exactClient)
        .register("eip155:8453" as Network, intentClient);

      const paymentRequired = buildPaymentRequired({
        accepts: [buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network })],
      });

      await client.createPaymentPayload(paymentRequired);

      expect(exactClient.createPaymentPayloadCalls.length).toBe(1);
    });

    it("should allow same scheme on multiple networks", async () => {
      const client = new x402Client();
      const evmClient = new MockSchemeNetworkClient("exact");
      const svmClient = new MockSchemeNetworkClient("exact");

      client
        .register("eip155:8453" as Network, evmClient)
        .register("solana:mainnet" as Network, svmClient);

      // Should be able to create payload for either network
      const evmPaymentRequired = buildPaymentRequired({
        accepts: [buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network })],
      });

      await client.createPaymentPayload(evmPaymentRequired);

      expect(evmClient.createPaymentPayloadCalls.length).toBe(1);
    });

    it("runs scheme hooks only for the selected network pattern and scheme", async () => {
      const client = new x402Client();
      const order: string[] = [];

      client.onBeforePaymentCreation(async () => {
        order.push("manual");
      });
      client.register(
        "eip155:*" as Network,
        new MockSchemeNetworkClient("exact", undefined, {
          onBeforePaymentCreation: async () => {
            order.push("scheme");
          },
        }),
      );
      client.register(
        "eip155:*" as Network,
        new MockSchemeNetworkClient("other", undefined, {
          onBeforePaymentCreation: async () => {
            order.push("other-scheme");
          },
        }),
      );
      client.register(
        "solana:*" as Network,
        new MockSchemeNetworkClient("exact", undefined, {
          onBeforePaymentCreation: async () => {
            order.push("other-network");
          },
        }),
      );

      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
          ],
        }),
      );

      expect(order).toEqual(["manual", "scheme"]);
    });

    it("removes scheme client hook adapters when a scheme is re-registered without hooks", async () => {
      const client = new x402Client();
      let calls = 0;

      client.register(
        "test:network" as Network,
        new MockSchemeNetworkClient("test-scheme", undefined, {
          onBeforePaymentCreation: async () => {
            calls++;
          },
        }),
      );
      await client.createPaymentPayload(buildPaymentRequired());
      expect(calls).toBe(1);

      client.register("test:network" as Network, new MockSchemeNetworkClient("test-scheme"));
      await client.createPaymentPayload(buildPaymentRequired());
      expect(calls).toBe(1);
    });
  });

  describe("registerV1", () => {
    it("should register scheme for v1", () => {
      const client = new x402Client();
      const mockClient = new MockSchemeNetworkClient("exact");

      const result = client.registerV1("base-sepolia", mockClient);

      expect(result).toBe(client);
    });
  });

  describe("registerPolicy", () => {
    it("should add policy to policy chain", () => {
      const client = new x402Client();
      const policy: PaymentPolicy = (_version, _reqs) => _reqs;

      const result = client.registerPolicy(policy);

      expect(result).toBe(client);
    });

    it("should return this for chaining", () => {
      const client = new x402Client();
      const policy1: PaymentPolicy = (v, r) => r;
      const policy2: PaymentPolicy = (v, r) => r;

      const result = client.registerPolicy(policy1).registerPolicy(policy2);

      expect(result).toBe(client);
    });
  });

  describe("createPaymentPayload", () => {
    describe("Happy path", () => {
      it("should create payment payload from PaymentRequired", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");
        client.register("eip155:8453" as Network, mockClient);

        const paymentRequired = buildPaymentRequired({
          x402Version: 2,
          resource: { url: "https://example.com", description: "Test", mimeType: "text/plain" },
          accepts: [
            buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
          ],
          extensions: { testExtension: true },
        });

        const result = await client.createPaymentPayload(paymentRequired);

        expect(result.x402Version).toBe(2);
        expect(result.payload).toBeDefined();
        expect(result.resource).toEqual(paymentRequired.resource);
        expect(result.extensions).toEqual({ testExtension: true });
        expect(result.accepted).toBeDefined();
      });

      it("should call scheme client's createPaymentPayload", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");
        client.register("eip155:8453" as Network, mockClient);

        const paymentRequired = buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
          ],
        });

        await client.createPaymentPayload(paymentRequired);

        expect(mockClient.createPaymentPayloadCalls.length).toBe(1);
        expect(mockClient.createPaymentPayloadCalls[0].x402Version).toBe(2);
      });
    });

    describe("Error cases", () => {
      it("should throw if no client registered for x402 version", async () => {
        const client = new x402Client();

        const paymentRequired = buildPaymentRequired({
          x402Version: 2,
          accepts: [
            buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
          ],
        });

        await expect(
          async () => await client.createPaymentPayload(paymentRequired),
        ).rejects.toThrow("No client registered for x402 version: 2");
      });

      it("should throw if no matching scheme/network client found", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");
        client.register("eip155:8453" as Network, mockClient);

        const paymentRequired = buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network: "solana:mainnet" as Network, // Different network
            }),
          ],
        });

        await expect(
          async () => await client.createPaymentPayload(paymentRequired),
        ).rejects.toThrow("No network/scheme registered");
      });

      it("should throw if PaymentRequired has empty accepts array", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");
        client.register("eip155:8453" as Network, mockClient);

        const paymentRequired = buildPaymentRequired({
          accepts: [],
        });

        await expect(
          async () => await client.createPaymentPayload(paymentRequired),
        ).rejects.toThrow();
      });
    });

    describe("Policy application", () => {
      it("should filter requirements based on policy", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");
        client.register("eip155:8453" as Network, mockClient);

        // Policy that prefers cheap options
        const cheapPolicy: PaymentPolicy = (version, reqs) =>
          reqs.filter(r => BigInt(r.amount) < BigInt("500000"));

        client.registerPolicy(cheapPolicy);

        const expensiveReq = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
          amount: "1000000",
        });
        const cheapReq = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
          amount: "100000",
        });

        const paymentRequired = buildPaymentRequired({
          accepts: [expensiveReq, cheapReq],
        });

        await client.createPaymentPayload(paymentRequired);

        // Should have selected cheap option
        expect(mockClient.createPaymentPayloadCalls[0].requirements.amount).toBe("100000");
      });

      it("should apply multiple policies in order", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");
        client.register("eip155:*" as Network, mockClient);

        const executionOrder: number[] = [];

        const policy1: PaymentPolicy = (_version, reqs) => {
          executionOrder.push(1);
          return reqs.filter(r => r.network.startsWith("eip155:"));
        };

        const policy2: PaymentPolicy = (_version, reqs) => {
          executionOrder.push(2);
          return reqs.filter(r => BigInt(r.amount) < BigInt("500000"));
        };

        client.registerPolicy(policy1).registerPolicy(policy2);

        const paymentRequired = buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network: "solana:mainnet" as Network,
              amount: "100000",
            }),
            buildPaymentRequirements({
              scheme: "exact",
              network: "eip155:8453" as Network,
              amount: "1000000",
            }),
            buildPaymentRequirements({
              scheme: "exact",
              network: "eip155:1" as Network,
              amount: "100000",
            }),
          ],
        });

        await client.createPaymentPayload(paymentRequired);

        expect(executionOrder).toEqual([1, 2]);
        // Should have filtered to EIP-155 networks, then to cheap option
        expect(mockClient.createPaymentPayloadCalls[0].requirements.network).toBe("eip155:1");
      });

      it("should throw if all requirements filtered out by policies", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");
        client.register("eip155:8453" as Network, mockClient);

        // Policy that filters everything out
        const rejectAllPolicy: PaymentPolicy = (_version, _reqs) => [];

        client.registerPolicy(rejectAllPolicy);

        const paymentRequired = buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
          ],
        });

        await expect(
          async () => await client.createPaymentPayload(paymentRequired),
        ).rejects.toThrow("All payment requirements were filtered out by policies");
      });
    });

    describe("Scheme filtering", () => {
      it("should only select requirements for registered schemes", async () => {
        const client = new x402Client();
        const exactClient = new MockSchemeNetworkClient("exact");

        // Only register exact scheme
        client.register("eip155:8453" as Network, exactClient);

        const paymentRequired = buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({ scheme: "intent", network: "eip155:8453" as Network }),
            buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
            buildPaymentRequirements({ scheme: "other", network: "eip155:8453" as Network }),
          ],
        });

        await client.createPaymentPayload(paymentRequired);

        // Should have selected exact scheme
        expect(exactClient.createPaymentPayloadCalls[0].requirements.scheme).toBe("exact");
      });

      it("should throw if no registered scheme matches any requirement", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");

        client.register("eip155:8453" as Network, mockClient);

        const paymentRequired = buildPaymentRequired({
          accepts: [
            // All requirements are for networks we don't support
            buildPaymentRequirements({ scheme: "exact", network: "solana:mainnet" as Network }),
            buildPaymentRequirements({ scheme: "intent", network: "eip155:8453" as Network }),
          ],
        });

        await expect(
          async () => await client.createPaymentPayload(paymentRequired),
        ).rejects.toThrow("No network/scheme registered");
      });
    });

    describe("Network pattern matching", () => {
      it("should match wildcard network patterns", async () => {
        const client = new x402Client();
        const evmClient = new MockSchemeNetworkClient("exact");

        // Register with wildcard
        client.register("eip155:*" as Network, evmClient);

        const paymentRequired = buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
          ],
        });

        const result = await client.createPaymentPayload(paymentRequired);

        expect(result).toBeDefined();
        expect(evmClient.createPaymentPayloadCalls.length).toBe(1);
      });

      it("should handle exact network matches", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");

        client.register("eip155:8453" as Network, mockClient);

        const paymentRequired = buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
          ],
        });

        const result = await client.createPaymentPayload(paymentRequired);

        expect(result).toBeDefined();
      });
    });

    describe("Multiple options handling", () => {
      it("should select from multiple payment requirements", async () => {
        const client = new x402Client();
        const exactClient = new MockSchemeNetworkClient("exact");

        client.register("eip155:*" as Network, exactClient);

        const paymentRequired = buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network: "eip155:8453" as Network,
              amount: "100",
            }),
            buildPaymentRequirements({
              scheme: "exact",
              network: "eip155:1" as Network,
              amount: "200",
            }),
            buildPaymentRequirements({
              scheme: "exact",
              network: "eip155:84532" as Network,
              amount: "300",
            }),
          ],
        });

        await client.createPaymentPayload(paymentRequired);

        // Default selector chooses first
        expect(exactClient.createPaymentPayloadCalls[0].requirements.amount).toBe("100");
      });

      it("should respect custom selector logic", async () => {
        // Selector that chooses cheapest option
        const cheapestSelector = (version: number, reqs: PaymentRequirements[]) => {
          return reqs.reduce((cheapest, current) =>
            BigInt(current.amount) < BigInt(cheapest.amount) ? current : cheapest,
          );
        };

        const client = new x402Client(cheapestSelector);
        const mockClient = new MockSchemeNetworkClient("exact");
        client.register("eip155:*" as Network, mockClient);

        const paymentRequired = buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network: "eip155:8453" as Network,
              amount: "1000000",
            }),
            buildPaymentRequirements({
              scheme: "exact",
              network: "eip155:1" as Network,
              amount: "100000",
            }), // Cheapest
            buildPaymentRequirements({
              scheme: "exact",
              network: "eip155:84532" as Network,
              amount: "500000",
            }),
          ],
        });

        await client.createPaymentPayload(paymentRequired);

        expect(mockClient.createPaymentPayloadCalls[0].requirements.amount).toBe("100000");
      });
    });
  });

  describe("Extension Hooks", () => {
    it("should register and invoke extensions that match paymentRequired.extensions", async () => {
      const client = new x402Client();
      const mockClient = new MockSchemeNetworkClient("exact");
      client.register("eip155:84532" as Network, mockClient);

      let enrichCalled = false;
      client.registerExtension({
        key: "testExtension",
        enrichPaymentPayload: async (payload, _paymentRequired) => {
          enrichCalled = true;
          return {
            ...payload,
            extensions: {
              ...payload.extensions,
              testExtension: { info: { enriched: true } },
            },
          };
        },
      });

      const paymentRequired = buildPaymentRequired({
        accepts: [
          buildPaymentRequirements({
            scheme: "exact",
            network: "eip155:84532" as Network,
          }),
        ],
        extensions: {
          testExtension: { info: { description: "test" }, schema: {} },
        },
      });

      const result = await client.createPaymentPayload(paymentRequired);

      expect(enrichCalled).toBe(true);
      expect((result.extensions as Record<string, unknown>)?.testExtension).toEqual({
        info: { enriched: true },
      });
    });

    it("should NOT invoke extension when key is not in paymentRequired.extensions", async () => {
      const client = new x402Client();
      const mockClient = new MockSchemeNetworkClient("exact");
      client.register("eip155:84532" as Network, mockClient);

      let enrichCalled = false;
      client.registerExtension({
        key: "missingExtension",
        enrichPaymentPayload: async payload => {
          enrichCalled = true;
          return payload;
        },
      });

      const paymentRequired = buildPaymentRequired({
        accepts: [
          buildPaymentRequirements({
            scheme: "exact",
            network: "eip155:84532" as Network,
          }),
        ],
        extensions: {},
      });

      await client.createPaymentPayload(paymentRequired);

      expect(enrichCalled).toBe(false);
    });

    it("should support chaining registerExtension", () => {
      const client = new x402Client();
      const result = client.registerExtension({ key: "ext1" }).registerExtension({ key: "ext2" });

      expect(result).toBe(client);
    });
  });
});
