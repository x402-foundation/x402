import { describe, it, expect } from "vitest";
import { x402Client } from "../../../src/client/x402Client";
import { PaymentPolicy } from "../../../src/client/x402Client";
import { MockSchemeNetworkClient } from "../../mocks";
import { buildPaymentPayload, buildPaymentRequired, buildPaymentRequirements } from "../../mocks";
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
          {
            ...buildPaymentRequirements({
              scheme: "v1-scheme",
              network: "base-sepolia" as Network,
            }),
            maxAmountRequired: "1000000",
          } as unknown as PaymentRequirements,
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

      it("deep merges server extension data when scheme extensions add fields", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact", {
          x402Version: 2,
          payload: { signature: "mock_signature" },
          extensions: {
            gas: {
              info: {
                permit: { signature: "0xpermit" },
                nested: { clientField: "client" },
              },
              schema: {
                properties: {
                  permit: { type: "object" },
                },
              },
              metadata: {
                nested: { clientField: "client" },
              },
            },
          },
        } as any);
        client.register("eip155:8453" as Network, mockClient);

        const result = await client.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
            ],
            extensions: {
              gas: {
                info: {
                  description: "Gas sponsoring",
                  version: 1,
                  nested: { serverField: "server" },
                },
                schema: {
                  type: "object",
                  properties: {
                    description: { type: "string" },
                  },
                },
                metadata: {
                  nested: { serverField: "server" },
                },
              },
            },
          }),
        );

        expect(result.extensions?.gas).toEqual({
          info: {
            description: "Gas sponsoring",
            version: 1,
            nested: { serverField: "server", clientField: "client" },
            permit: { signature: "0xpermit" },
          },
          schema: {
            type: "object",
            properties: {
              description: { type: "string" },
              permit: { type: "object" },
            },
          },
          metadata: {
            nested: { serverField: "server", clientField: "client" },
          },
        });
      });

      it("merges conflicting array fields instead of replacing client values", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact", {
          x402Version: 2,
          payload: { signature: "mock_signature" },
        } as any);
        client.register("eip155:8453" as Network, mockClient);
        client.registerExtension({
          key: "builder-code",
          enrichPaymentPayload: async payload => ({
            ...payload,
            extensions: {
              ...payload.extensions,
              "builder-code": { info: { s: ["bc_shared", "bc_client"] } },
            },
          }),
        });

        const result = await client.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
            ],
            extensions: {
              "builder-code": {
                info: { a: "bc_app", s: ["bc_server", "bc_shared"] },
                schema: { type: "object" },
              },
            },
          }),
        );

        expect(result.extensions?.["builder-code"]).toEqual({
          info: { a: "bc_app", s: ["bc_shared", "bc_client", "bc_server"] },
          schema: { type: "object" },
        });
      });

      it("merges a scalar array field against an array on the other side", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact", {
          x402Version: 2,
          payload: { signature: "mock_signature" },
        } as any);
        client.register("eip155:8453" as Network, mockClient);
        client.registerExtension({
          key: "builder-code",
          enrichPaymentPayload: async payload => ({
            ...payload,
            extensions: {
              ...payload.extensions,
              "builder-code": { info: { s: ["bc_client"] } },
            },
          }),
        });

        const result = await client.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
            ],
            extensions: {
              "builder-code": {
                info: { a: "bc_app", s: "bc_server" },
                schema: { type: "object" },
              },
            },
          }),
        );

        expect(result.extensions?.["builder-code"]).toEqual({
          info: { a: "bc_app", s: ["bc_client", "bc_server"] },
          schema: { type: "object" },
        });
      });

      it("dedupes repeated entries within a single side of a merged array field", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact", {
          x402Version: 2,
          payload: { signature: "mock_signature" },
        } as any);
        client.register("eip155:8453" as Network, mockClient);
        client.registerExtension({
          key: "builder-code",
          enrichPaymentPayload: async payload => ({
            ...payload,
            extensions: {
              ...payload.extensions,
              "builder-code": { info: { s: ["bc_client", "bc_client"] } },
            },
          }),
        });

        const result = await client.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
            ],
            extensions: {
              "builder-code": {
                info: { a: "bc_app", s: ["bc_server", "bc_server"] },
                schema: { type: "object" },
              },
            },
          }),
        );

        expect(result.extensions?.["builder-code"]).toEqual({
          info: { a: "bc_app", s: ["bc_client", "bc_server"] },
          schema: { type: "object" },
        });
      });

      it("keeps the server array for a non-additive extension field instead of concatenating", async () => {
        // Array concatenation is scoped to ADDITIVE_ARRAY_INFO_FIELDS (builder-code's
        // `s`); other extensions' conflicting array fields must keep the server's
        // value, matching x402ResourceServer's exact-match requirement for them.
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact", {
          x402Version: 2,
          payload: { signature: "mock_signature" },
        } as any);
        client.register("eip155:8453" as Network, mockClient);
        client.registerExtension({
          key: "sign-in-with-x",
          enrichPaymentPayload: async payload => ({
            ...payload,
            extensions: {
              ...payload.extensions,
              "sign-in-with-x": { info: { resources: ["https://evil.example.com"] } },
            },
          }),
        });

        const result = await client.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
            ],
            extensions: {
              "sign-in-with-x": {
                info: { resources: ["https://api.example.com/data"] },
              },
            },
          }),
        );

        expect(result.extensions?.["sign-in-with-x"]).toEqual({
          info: { resources: ["https://api.example.com/data"] },
        });
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

    describe("Payment flow selection", () => {
      it("should drop accepts with unrecognized paymentFlow", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");
        client.register("eip155:8453" as Network, mockClient);

        const knownReq = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
          amount: "100",
        });
        const unknownReq = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
          amount: "200",
          extra: { paymentFlow: "future-flow" },
        });

        const paymentRequired = buildPaymentRequired({
          accepts: [unknownReq, knownReq],
        });

        await client.createPaymentPayload(paymentRequired);

        expect(mockClient.createPaymentPayloadCalls[0].requirements).toEqual(knownReq);
      });

      it("should throw when every accept has unrecognized paymentFlow", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");
        client.register("eip155:8453" as Network, mockClient);

        const paymentRequired = buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network: "eip155:8453" as Network,
              extra: { paymentFlow: "future-flow" },
            }),
          ],
        });

        await expect(client.createPaymentPayload(paymentRequired)).rejects.toThrow(
          "No payment requirements with a recognized paymentFlow",
        );
      });

      it("should prefer authorization over upfront when both are offered", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");
        client.register("eip155:8453" as Network, mockClient);

        const upfrontReq = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
          amount: "100",
          extra: { paymentFlow: "upfront" },
        });
        const authReq = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
          amount: "200",
        });

        const paymentRequired = buildPaymentRequired({
          accepts: [upfrontReq, authReq],
        });

        await client.createPaymentPayload(paymentRequired);

        expect(mockClient.createPaymentPayloadCalls[0].requirements).toEqual(authReq);
      });

      it("should prefer explicit authorization over escrow when both are offered", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");
        client.register("eip155:8453" as Network, mockClient);

        const escrowReq = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
          amount: "100",
          extra: { paymentFlow: "escrow" },
        });
        const authReq = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
          amount: "200",
          extra: { paymentFlow: "authorization" },
        });

        const paymentRequired = buildPaymentRequired({
          accepts: [escrowReq, authReq],
        });

        await client.createPaymentPayload(paymentRequired);

        expect(mockClient.createPaymentPayloadCalls[0].requirements).toEqual(authReq);
      });

      it("should still select upfront when it is the only remaining accept", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");
        client.register("eip155:8453" as Network, mockClient);

        const upfrontReq = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
          amount: "100",
          extra: { paymentFlow: "upfront" },
        });

        const paymentRequired = buildPaymentRequired({
          accepts: [upfrontReq],
        });

        await client.createPaymentPayload(paymentRequired);

        expect(mockClient.createPaymentPayloadCalls[0].requirements).toEqual(upfrontReq);
      });

      it("should let custom policies override authorization preference", async () => {
        const client = new x402Client();
        const mockClient = new MockSchemeNetworkClient("exact");
        client.register("eip155:8453" as Network, mockClient);

        const upfrontReq = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
          amount: "100",
          extra: { paymentFlow: "upfront" },
        });
        const authReq = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
          amount: "200",
        });

        const upfrontOnlyPolicy: PaymentPolicy = (_version, reqs) =>
          reqs.filter(r => r.extra?.paymentFlow === "upfront");

        client.registerPolicy(upfrontOnlyPolicy);

        const paymentRequired = buildPaymentRequired({
          accepts: [authReq, upfrontReq],
        });

        await client.createPaymentPayload(paymentRequired);

        expect(mockClient.createPaymentPayloadCalls[0].requirements).toEqual(upfrontReq);
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
        info: { description: "test", enriched: true },
        schema: {},
      });
    });

    it("should invoke registered extension enrichPaymentPayload even when key is not in paymentRequired.extensions", async () => {
      const client = new x402Client();
      const mockClient = new MockSchemeNetworkClient("exact");
      client.register("eip155:84532" as Network, mockClient);

      let enrichCalled = false;
      client.registerExtension({
        key: "clientOwnedExtension",
        enrichPaymentPayload: async payload => {
          enrichCalled = true;
          return {
            ...payload,
            extensions: {
              ...payload.extensions,
              clientOwnedExtension: { info: { s: "client_data" } },
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
        extensions: {},
      });

      const result = await client.createPaymentPayload(paymentRequired);

      expect(enrichCalled).toBe(true);
      expect((result.extensions as Record<string, unknown>)?.clientOwnedExtension).toEqual({
        info: { s: "client_data" },
      });
    });

    it("should support chaining registerExtension", () => {
      const client = new x402Client();
      const result = client.registerExtension({ key: "ext1" }).registerExtension({ key: "ext2" });

      expect(result).toBe(client);
    });

    it("should expose registered extensions", () => {
      const client = new x402Client();
      const extension = { key: "ext1" };

      client.registerExtension(extension);

      expect(client.getExtensions()).toEqual([extension]);
    });

    it("should run declared lifecycle hooks after manual and scheme hooks", async () => {
      const client = new x402Client();
      const order: string[] = [];

      client.onBeforePaymentCreation(async () => {
        order.push("manual-before");
      });
      client.onAfterPaymentCreation(async () => {
        order.push("manual-after");
      });
      client.register(
        "eip155:*" as Network,
        new MockSchemeNetworkClient("exact", undefined, {
          onBeforePaymentCreation: async () => {
            order.push("scheme-before");
          },
          onAfterPaymentCreation: async () => {
            order.push("scheme-after");
          },
        }),
      );
      client.registerExtension({
        key: "clientExtension",
        hooks: {
          onBeforePaymentCreation: async declaration => {
            order.push("extension-before");
            expect(declaration).toEqual({ enabled: true });
          },
          onAfterPaymentCreation: async declaration => {
            order.push("extension-after");
            expect(declaration).toEqual({ enabled: true });
          },
        },
      });

      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
          ],
          extensions: { clientExtension: { enabled: true } },
        }),
      );

      expect(order).toEqual([
        "manual-before",
        "scheme-before",
        "extension-before",
        "manual-after",
        "scheme-after",
        "extension-after",
      ]);
    });

    it("should skip lifecycle hooks for undeclared extensions", async () => {
      const client = new x402Client();
      let extensionCalled = false;

      client.register("eip155:*" as Network, new MockSchemeNetworkClient("exact"));
      client.registerExtension({
        key: "clientExtension",
        hooks: {
          onBeforePaymentCreation: async () => {
            extensionCalled = true;
          },
          onAfterPaymentCreation: async () => {
            extensionCalled = true;
          },
        },
      });

      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
          ],
        }),
      );

      expect(extensionCalled).toBe(false);
    });

    it("should let declared extension failure hooks recover after manual and scheme hooks", async () => {
      const client = new x402Client();
      const order: string[] = [];
      const recoveredPayload = buildPaymentPayload();

      client.onPaymentCreationFailure(async () => {
        order.push("manual-failure");
      });
      client.register(
        "eip155:*" as Network,
        new MockSchemeNetworkClient("exact", new Error("scheme failed"), {
          onPaymentCreationFailure: async () => {
            order.push("scheme-failure");
          },
        }),
      );
      client.registerExtension({
        key: "clientExtension",
        hooks: {
          onPaymentCreationFailure: async declaration => {
            order.push("extension-failure");
            expect(declaration).toEqual({ enabled: true });
            return { recovered: true, payload: recoveredPayload };
          },
        },
      });

      const result = await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
          ],
          extensions: { clientExtension: { enabled: true } },
        }),
      );

      expect(result).toBe(recoveredPayload);
      expect(order).toEqual(["manual-failure", "scheme-failure", "extension-failure"]);
    });

    it("should run declared payment response hooks after manual and scheme hooks", async () => {
      const client = new x402Client();
      const order: string[] = [];
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      client.onPaymentResponse(async () => {
        order.push("manual-response");
      });
      client.register(
        "eip155:*" as Network,
        new MockSchemeNetworkClient("exact", undefined, {
          onPaymentResponse: async () => {
            order.push("scheme-response");
          },
        }),
      );
      client.registerExtension({
        key: "clientExtension",
        hooks: {
          onPaymentResponse: async declaration => {
            order.push("extension-response");
            expect(declaration).toEqual({ enabled: true });
          },
        },
      });

      await client.handlePaymentResponse({
        paymentPayload: buildPaymentPayload({
          accepted: requirements,
          extensions: { clientExtension: { enabled: true } },
        }),
        requirements,
      });

      expect(order).toEqual(["manual-response", "scheme-response", "extension-response"]);
    });
  });

  describe("spendControls", () => {
    const network = "eip155:8453" as Network;
    const usdc = {
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
      symbol: "USDC",
    };
    const usdt = {
      asset: "0xUsdTSecondaryAsset0000000000000000000001",
      decimals: 6,
      symbol: "USDT",
    };
    const mUsd = {
      asset: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
      decimals: 18,
      symbol: "mUSD",
    };

    function clientWithDefaultAsset(
      entry: { asset: string; decimals: number; symbol: string } = usdc,
      controls?: Parameters<x402Client["setSpendControls"]>[0],
    ) {
      const mockClient = new MockSchemeNetworkClient("exact");
      mockClient.setFindDefaultAsset((asset, _network) =>
        asset.toLowerCase() === entry.asset.toLowerCase() ? entry : undefined,
      );
      const client = new x402Client();
      client.register(network, mockClient);
      if (controls !== undefined) {
        client.setSpendControls(controls);
      }
      return { client, mockClient };
    }

    it("allows a payment at or below the default $1 USD cap", async () => {
      const { client, mockClient } = clientWithDefaultAsset();
      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "1000000", // $1
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls).toHaveLength(1);
    });

    it("rejects a payment above the default $1 USD cap", async () => {
      const { client } = clientWithDefaultAsset();
      await expect(
        client.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({
                scheme: "exact",
                network,
                asset: usdc.asset,
                amount: "1000001",
              }),
            ],
          }),
        ),
      ).rejects.toThrow(/maxAmountPerPayment/);
    });

    it("picks the affordable accept when both under and over the cap are offered", async () => {
      const { client, mockClient } = clientWithDefaultAsset();
      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "50000000", // $50
            }),
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "500000", // $0.50
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls[0].requirements.amount).toBe("500000");
    });

    it("caps a second USD asset on the same network identically to the default", async () => {
      const mockClient = new MockSchemeNetworkClient("exact");
      mockClient.setFindDefaultAsset((asset, _network) => {
        const lower = asset.toLowerCase();
        if (lower === usdc.asset.toLowerCase()) return usdc;
        if (lower === usdt.asset.toLowerCase()) return usdt;
        return undefined;
      });
      const client = new x402Client();
      client.register(network, mockClient);

      await expect(
        client.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({
                scheme: "exact",
                network,
                asset: usdt.asset,
                amount: "2000000",
              }),
            ],
          }),
        ),
      ).rejects.toThrow(/maxAmountPerPayment/);
    });

    it("rejects unrecognized assets by default and schemes without findDefaultAsset", async () => {
      const { client } = clientWithDefaultAsset();
      await expect(
        client.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({
                scheme: "exact",
                network,
                asset: "0xCustomUnknownToken",
                amount: "1",
              }),
            ],
          }),
        ),
      ).rejects.toThrow(/spendControls\.allowedAssets/);

      const bare = new MockSchemeNetworkClient("exact");
      bare.clearFindDefaultAsset();
      const bareClient = new x402Client();
      bareClient.register(network, bare);
      await expect(
        bareClient.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({
                scheme: "exact",
                network,
                asset: usdc.asset,
                amount: "1",
              }),
            ],
          }),
        ),
      ).rejects.toThrow(/spendControls\.allowedAssets/);
    });

    it("spendControls: false disables allowlist and USD cap", async () => {
      const custom = "0xCustomUnknownToken";
      const { client, mockClient } = clientWithDefaultAsset(usdc, false);

      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: custom,
              amount: "999999999999",
            }),
          ],
        }),
      );
      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "5000000",
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls).toHaveLength(2);
    });

    it("allowedAssets: true allows any asset while still applying the USD cap to defaults", async () => {
      const custom = "0xCustomUnknownToken";
      const { client, mockClient } = clientWithDefaultAsset(usdc, {
        allowedAssets: true,
      });

      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: custom,
              amount: "999999999999",
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls).toHaveLength(1);

      await expect(
        client.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({
                scheme: "exact",
                network,
                asset: usdc.asset,
                amount: "1000001",
              }),
            ],
          }),
        ),
      ).rejects.toThrow(/maxAmountPerPayment/);
    });

    it("scales the USD cap for an 18-decimal default asset", async () => {
      const mockClient = new MockSchemeNetworkClient("exact");
      mockClient.setFindDefaultAsset(mUsd);
      const mezo = "eip155:31611" as Network;
      const client18 = new x402Client().register(mezo, mockClient);

      await expect(
        client18.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({
                scheme: "exact",
                network: mezo,
                asset: mUsd.asset,
                amount: "1000000000000000001", // > $1 at 18 decimals
              }),
            ],
          }),
        ),
      ).rejects.toThrow(/maxAmountPerPayment/);

      await client18.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network: mezo,
              asset: mUsd.asset,
              amount: "1000000000000000000", // exactly $1
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls).toHaveLength(1);
    });

    it("honours maxAmountPerPayment: false, custom Money, and setSpendControls", async () => {
      const { client, mockClient } = clientWithDefaultAsset(usdc, {
        maxAmountPerPayment: false,
      });
      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "5000000",
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls).toHaveLength(1);

      const mock5 = new MockSchemeNetworkClient("exact");
      mock5.setFindDefaultAsset(usdc);
      const client5 = x402Client.fromConfig({
        schemes: [{ network, client: mock5 }],
        spendControls: { maxAmountPerPayment: "$5" },
      });
      await client5.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "5000000",
            }),
          ],
        }),
      );
      expect(mock5.createPaymentPayloadCalls).toHaveLength(1);

      const mockNum = new MockSchemeNetworkClient("exact");
      mockNum.setFindDefaultAsset(usdc);
      const clientNum = new x402Client().register(network, mockNum).setSpendControls({
        maxAmountPerPayment: 5,
      });
      await clientNum.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "5000000",
            }),
          ],
        }),
      );
      expect(mockNum.createPaymentPayloadCalls).toHaveLength(1);
    });

    it("allows opt-in assets uncapped or with an atomic maxAmountPerPayment", async () => {
      const customAsset = "0xCustomToken";
      const { client: cappedClient } = clientWithDefaultAsset(usdc, {
        allowedAssets: [{ asset: customAsset, network, maxAmountPerPayment: "10000" }],
      });

      await expect(
        cappedClient.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({
                scheme: "exact",
                network,
                asset: customAsset,
                amount: "10001",
              }),
            ],
          }),
        ),
      ).rejects.toThrow(/allowedAssets maxAmountPerPayment/);

      const { client: uncappedClient, mockClient } = clientWithDefaultAsset(usdc, {
        allowedAssets: [{ asset: customAsset.toLowerCase(), network: "eip155:*" as Network }],
      });
      await uncappedClient.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: customAsset,
              amount: "999999999999",
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls).toHaveLength(1);
    });

    it("drops a non-integer 402 amount on the per-asset atomic cap path", async () => {
      const customAsset = "0xCustomToken";
      const { client } = clientWithDefaultAsset(usdc, {
        allowedAssets: [{ asset: customAsset, network, maxAmountPerPayment: "10000" }],
      });

      await expect(
        client.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({
                scheme: "exact",
                network,
                asset: customAsset,
                amount: "1.5",
              }),
            ],
          }),
        ),
      ).rejects.toThrow(/allowedAssets maxAmountPerPayment/);
    });

    it("keeps a sibling accept when a mixed offer has a non-integer per-asset amount", async () => {
      const customAsset = "0xCustomToken";
      const { client, mockClient } = clientWithDefaultAsset(usdc, {
        allowedAssets: [{ asset: customAsset, network, maxAmountPerPayment: "10000" }],
      });

      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: customAsset,
              amount: "1.5",
            }),
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: customAsset,
              amount: "100",
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls[0].requirements.amount).toBe("100");
    });

    it("errors when a per-asset cap is not an integer atomic amount", async () => {
      const customAsset = "0xCustomToken";
      for (const cap of ["$1", "1.5"] as const) {
        const { client } = clientWithDefaultAsset(usdc, {
          allowedAssets: [{ asset: customAsset, network, maxAmountPerPayment: cap }],
        });

        await expect(
          client.createPaymentPayload(
            buildPaymentRequired({
              accepts: [
                buildPaymentRequirements({
                  scheme: "exact",
                  network,
                  asset: customAsset,
                  amount: "100",
                }),
              ],
            }),
          ),
        ).rejects.toThrow(/maxAmountPerPayment must be an integer atomic amount/);
      }
    });

    it("overrides the USD cap for default assets by id or symbol", async () => {
      const { client: byId, mockClient: mockById } = clientWithDefaultAsset(usdc, {
        allowedAssets: [{ asset: usdc.asset, network, maxAmountPerPayment: "500000" }],
      });

      await expect(
        byId.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({
                scheme: "exact",
                network,
                asset: usdc.asset,
                amount: "600000",
              }),
            ],
          }),
        ),
      ).rejects.toThrow(/allowedAssets maxAmountPerPayment/);

      await byId.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "400000",
            }),
          ],
        }),
      );
      expect(mockById.createPaymentPayloadCalls).toHaveLength(1);

      const pyusd = {
        asset: "0xPayPalUsdAsset000000000000000000000001",
        decimals: 6,
        symbol: "PYUSD",
      };
      const mockPyusd = new MockSchemeNetworkClient("exact");
      mockPyusd.setFindDefaultAsset((asset, _network) =>
        asset.toLowerCase() === pyusd.asset.toLowerCase() ? pyusd : undefined,
      );
      const clientBySymbol = new x402Client().register(network, mockPyusd).setSpendControls({
        allowedAssets: [{ asset: "pyusd", network, maxAmountPerPayment: "500000" }],
      });

      await expect(
        clientBySymbol.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({
                scheme: "exact",
                network,
                asset: pyusd.asset,
                amount: "600000",
              }),
            ],
          }),
        ),
      ).rejects.toThrow(/allowedAssets maxAmountPerPayment/);

      await clientBySymbol.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: pyusd.asset,
              amount: "400000",
            }),
          ],
        }),
      );
      expect(mockPyusd.createPaymentPayloadCalls).toHaveLength(1);
    });

    it("keeps the USD cap when a default asset is listed without a per-entry cap", async () => {
      const { client } = clientWithDefaultAsset(usdc, {
        allowedAssets: [{ asset: usdc.symbol, network }],
      });

      await expect(
        client.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({
                scheme: "exact",
                network,
                asset: usdc.asset,
                amount: "1000001",
              }),
            ],
          }),
        ),
      ).rejects.toThrow(/maxAmountPerPayment/);
    });

    it("allows defaults plus listed custom assets", async () => {
      const custom = "0xCustomToken";
      const { client, mockClient } = clientWithDefaultAsset(usdc, {
        maxAmountPerPayment: false,
        allowedAssets: [{ asset: custom, network }],
      });

      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "1",
            }),
          ],
        }),
      );
      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: custom,
              amount: "1",
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls).toHaveLength(2);
    });

    it("caps v1 accepts via maxAmountRequired", async () => {
      const mockClient = new MockSchemeNetworkClient("exact");
      mockClient.setFindDefaultAsset(usdc);
      const client = new x402Client();
      client.registerV1("base" as Network, mockClient);

      const v1Req = {
        scheme: "exact",
        network: "base",
        asset: usdc.asset,
        maxAmountRequired: "2000000",
        payTo: "0xpay",
        maxTimeoutSeconds: 60,
        description: "",
        mimeType: "",
        resource: "https://example.com",
      } as unknown as PaymentRequirements;

      await expect(
        client.createPaymentPayload(
          buildPaymentRequired({
            x402Version: 1,
            accepts: [v1Req],
          }),
        ),
      ).rejects.toThrow(/maxAmountPerPayment/);
    });

    it("only exposes requirements that passed spend controls to user policies", async () => {
      const seen: string[] = [];
      const { client, mockClient } = clientWithDefaultAsset(usdc);
      client.registerPolicy((_version, reqs) => {
        seen.push(...reqs.map(r => r.amount));
        return reqs;
      });

      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "50000000",
            }),
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "250000",
            }),
          ],
        }),
      );

      expect(seen).toEqual(["250000"]);
      expect(mockClient.createPaymentPayloadCalls[0].requirements.amount).toBe("250000");
    });

    it("compares non-integer decimal amounts to the USD cap directly", async () => {
      const rlusd = {
        asset: "524C555344000000000000000000000000000000",
        decimals: 15,
        symbol: "RLUSD",
      };
      const mockClient = new MockSchemeNetworkClient("exact");
      mockClient.setFindDefaultAsset(rlusd);
      const xrpl = "xrpl:1" as Network;
      const client = new x402Client().register(xrpl, mockClient);

      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network: xrpl,
              asset: rlusd.asset,
              amount: "1.0",
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls).toHaveLength(1);

      await expect(
        client.createPaymentPayload(
          buildPaymentRequired({
            accepts: [
              buildPaymentRequirements({
                scheme: "exact",
                network: xrpl,
                asset: rlusd.asset,
                amount: "1.01",
              }),
            ],
          }),
        ),
      ).rejects.toThrow(/maxAmountPerPayment/);
    });

    it("passes the resolved atomic spend cap on payment payload context", async () => {
      const { client, mockClient } = clientWithDefaultAsset(usdc);
      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "1000",
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls[0].context?.maxAmountPerPayment).toBe("1000000");
    });

    it("omits the spend cap on context when spend controls are disabled", async () => {
      const { client, mockClient } = clientWithDefaultAsset(usdc, false);
      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "5000000",
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls[0].context?.maxAmountPerPayment).toBeUndefined();
    });

    it("omits the spend cap on context when the USD cap is disabled", async () => {
      const { client, mockClient } = clientWithDefaultAsset(usdc, { maxAmountPerPayment: false });
      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "5000000",
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls[0].context?.maxAmountPerPayment).toBeUndefined();
    });

    it("passes a custom Money USD cap on context in atomic units", async () => {
      const { client, mockClient } = clientWithDefaultAsset(usdc, { maxAmountPerPayment: "$5" });
      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "1000",
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls[0].context?.maxAmountPerPayment).toBe("5000000");
    });

    it("passes an allowedAssets atomic cap on context", async () => {
      const { client, mockClient } = clientWithDefaultAsset(usdc, {
        allowedAssets: [{ asset: usdc.asset, network, maxAmountPerPayment: "500000" }],
      });
      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({
              scheme: "exact",
              network,
              asset: usdc.asset,
              amount: "100",
            }),
          ],
        }),
      );
      expect(mockClient.createPaymentPayloadCalls[0].context?.maxAmountPerPayment).toBe("500000");
    });
  });
});
