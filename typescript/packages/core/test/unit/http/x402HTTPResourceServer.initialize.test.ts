import { describe, it, expect, beforeEach } from "vitest";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import {
  x402HTTPResourceServer,
  RouteConfigurationError,
} from "../../../src/http/x402HTTPResourceServer";
import { RoutesConfig } from "../../../src/http/x402HTTPResourceServer";
import { Network } from "../../../src/types";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildSupportedResponse,
} from "../../mocks";

describe("x402HTTPResourceServer.initialize", () => {
  let server: x402ResourceServer;
  let mockClient: MockFacilitatorClient;
  let mockScheme: MockSchemeNetworkServer;

  const testNetwork = "eip155:84532" as Network;
  const testScheme = "exact";

  beforeEach(() => {
    mockScheme = new MockSchemeNetworkServer(testScheme);
  });

  describe("with properly configured server", () => {
    beforeEach(() => {
      mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: testScheme, network: testNetwork }],
        }),
      );
      server = new x402ResourceServer(mockClient);
      server.register(testNetwork, mockScheme);
    });

    it("should initialize successfully with valid routes", async () => {
      const routes: RoutesConfig = {
        "GET /api/data": {
          accepts: {
            scheme: testScheme,
            payTo: "0x123",
            price: "$0.01",
            network: testNetwork,
          },
          description: "Test endpoint",
        },
      };

      const httpServer = new x402HTTPResourceServer(server, routes);

      await expect(httpServer.initialize()).resolves.not.toThrow();
    });

    it("should initialize with array of payment options", async () => {
      const routes: RoutesConfig = {
        "GET /api/data": {
          accepts: [
            {
              scheme: testScheme,
              payTo: "0x123",
              price: "$0.01",
              network: testNetwork,
            },
          ],
          description: "Test endpoint",
        },
      };

      const httpServer = new x402HTTPResourceServer(server, routes);

      await expect(httpServer.initialize()).resolves.not.toThrow();
    });

    it("should initialize with single route config format", async () => {
      const routes: RoutesConfig = {
        accepts: {
          scheme: testScheme,
          payTo: "0x123",
          price: "$0.01",
          network: testNetwork,
        },
        description: "Test endpoint",
      };

      const httpServer = new x402HTTPResourceServer(server, routes);

      await expect(httpServer.initialize()).resolves.not.toThrow();
    });
  });

  describe("with missing scheme registration", () => {
    beforeEach(() => {
      mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: testScheme, network: testNetwork }],
        }),
      );
      server = new x402ResourceServer(mockClient);
      // Note: NOT registering the scheme
    });

    it("should throw RouteConfigurationError for unregistered scheme", async () => {
      const routes: RoutesConfig = {
        "GET /api/data": {
          accepts: {
            scheme: testScheme,
            payTo: "0x123",
            price: "$0.01",
            network: testNetwork,
          },
          description: "Test endpoint",
        },
      };

      const httpServer = new x402HTTPResourceServer(server, routes);

      await expect(httpServer.initialize()).rejects.toThrow(RouteConfigurationError);

      try {
        await httpServer.initialize();
      } catch (error) {
        expect(error).toBeInstanceOf(RouteConfigurationError);
        const configError = error as RouteConfigurationError;
        expect(configError.errors).toHaveLength(1);
        expect(configError.errors[0].reason).toBe("missing_scheme");
        expect(configError.errors[0].routePattern).toBe("GET /api/data");
        expect(configError.errors[0].message).toContain("No scheme implementation registered");
      }
    });
  });

  describe("with missing facilitator support", () => {
    beforeEach(() => {
      mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "other-scheme", network: testNetwork }],
        }),
      );
      server = new x402ResourceServer(mockClient);
      server.register(testNetwork, mockScheme);
    });

    it("should throw RouteConfigurationError for unsupported facilitator", async () => {
      const routes: RoutesConfig = {
        "POST /api/payment": {
          accepts: {
            scheme: testScheme,
            payTo: "0x123",
            price: "$0.01",
            network: testNetwork,
          },
          description: "Test endpoint",
        },
      };

      const httpServer = new x402HTTPResourceServer(server, routes);

      await expect(httpServer.initialize()).rejects.toThrow(RouteConfigurationError);

      try {
        await httpServer.initialize();
      } catch (error) {
        expect(error).toBeInstanceOf(RouteConfigurationError);
        const configError = error as RouteConfigurationError;
        expect(configError.errors).toHaveLength(1);
        expect(configError.errors[0].reason).toBe("missing_facilitator");
        expect(configError.errors[0].routePattern).toBe("POST /api/payment");
        expect(configError.errors[0].message).toContain("Facilitator does not support");
      }
    });
  });

  describe("with multiple routes and payment options", () => {
    const solanaNetwork = "solana:mainnet" as Network;
    let solanaScheme: MockSchemeNetworkServer;

    beforeEach(() => {
      solanaScheme = new MockSchemeNetworkServer("exact");
      mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [
            { x402Version: 2, scheme: testScheme, network: testNetwork },
            { x402Version: 2, scheme: "exact", network: solanaNetwork },
          ],
        }),
      );
      server = new x402ResourceServer(mockClient);
      server.register(testNetwork, mockScheme);
      server.register(solanaNetwork, solanaScheme);
    });

    it("should validate all routes and payment options", async () => {
      const routes: RoutesConfig = {
        "GET /api/data": {
          accepts: [
            {
              scheme: testScheme,
              payTo: "0x123",
              price: "$0.01",
              network: testNetwork,
            },
            {
              scheme: "exact",
              payTo: "solana_address",
              price: "$0.01",
              network: solanaNetwork,
            },
          ],
          description: "Multi-chain endpoint",
        },
        "POST /api/other": {
          accepts: {
            scheme: testScheme,
            payTo: "0x456",
            price: "$0.02",
            network: testNetwork,
          },
          description: "Another endpoint",
        },
      };

      const httpServer = new x402HTTPResourceServer(server, routes);

      await expect(httpServer.initialize()).resolves.not.toThrow();
    });

    it("should collect errors from multiple routes", async () => {
      const unsupportedNetwork = "unsupported:network" as Network;

      const routes: RoutesConfig = {
        "GET /api/valid": {
          accepts: {
            scheme: testScheme,
            payTo: "0x123",
            price: "$0.01",
            network: testNetwork,
          },
          description: "Valid endpoint",
        },
        "GET /api/invalid": {
          accepts: {
            scheme: testScheme,
            payTo: "0x456",
            price: "$0.01",
            network: unsupportedNetwork,
          },
          description: "Invalid endpoint",
        },
      };

      const httpServer = new x402HTTPResourceServer(server, routes);

      try {
        await httpServer.initialize();
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(RouteConfigurationError);
        const configError = error as RouteConfigurationError;
        expect(configError.errors).toHaveLength(1);
        expect(configError.errors[0].routePattern).toBe("GET /api/invalid");
      }
    });
  });

  describe("RouteConfigurationError", () => {
    it("should have formatted error message", async () => {
      mockClient = new MockFacilitatorClient(buildSupportedResponse());
      server = new x402ResourceServer(mockClient);

      const routes: RoutesConfig = {
        "GET /api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0x123",
            price: "$0.01",
            network: "eip155:84532" as Network,
          },
          description: "Test",
        },
      };

      const httpServer = new x402HTTPResourceServer(server, routes);

      try {
        await httpServer.initialize();
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(RouteConfigurationError);
        const configError = error as RouteConfigurationError;
        expect(configError.name).toBe("RouteConfigurationError");
        expect(configError.message).toContain("x402 Route Configuration Errors:");
        expect(configError.message).toContain("GET /api/test");
      }
    });
  });
});
