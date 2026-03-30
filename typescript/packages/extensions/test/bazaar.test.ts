/**
 * Tests for Bazaar Discovery Extension
 */

import { describe, it, expect } from "vitest";
import {
  BAZAAR,
  declareDiscoveryExtension,
  validateDiscoveryExtension,
  isValidRouteTemplate,
  extractDiscoveryInfo,
  extractDiscoveryInfoFromExtension,
  extractDiscoveryInfoV1,
  validateAndExtract,
  bazaarResourceServerExtension,
} from "../src/bazaar/index";
import type { BodyDiscoveryInfo, McpDiscoveryInfo, DiscoveryExtension } from "../src/bazaar/types";
import type { DiscoveredMCPResource } from "../src/bazaar/facilitator";
import type { HTTPAdapter, HTTPRequestContext } from "@x402/core/http";

describe("Bazaar Discovery Extension", () => {
  describe("BAZAAR constant", () => {
    it("should export the correct extension identifier", () => {
      expect(BAZAAR.key).toBe("bazaar");
    });
  });

  describe("declareDiscoveryExtension - GET method", () => {
    it("should create a valid GET extension with query params", () => {
      const result = declareDiscoveryExtension({
        input: { query: "test", limit: 10 },
        inputSchema: {
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
          required: ["query"],
        },
      });

      expect(result).toHaveProperty("bazaar");
      const extension = result.bazaar;
      expect(extension).toHaveProperty("info");
      expect(extension).toHaveProperty("schema");
      expect(extension.info.input.type).toBe("http");
      expect(extension.info.input.queryParams).toEqual({ query: "test", limit: 10 });
    });

    it("should create a GET extension with output example", () => {
      const outputExample = { results: [], total: 0 };
      const result = declareDiscoveryExtension({
        input: { query: "test" },
        inputSchema: {
          properties: {
            query: { type: "string" },
          },
        },
        output: {
          example: outputExample,
        },
      });

      const extension = result.bazaar;
      expect(extension.info.output?.example).toEqual(outputExample);
    });
  });

  describe("declareDiscoveryExtension - POST method", () => {
    it("should create a valid POST extension with JSON body", () => {
      const result = declareDiscoveryExtension({
        input: { name: "John", age: 30 },
        inputSchema: {
          properties: {
            name: { type: "string" },
            age: { type: "number" },
          },
          required: ["name"],
        },
        bodyType: "json",
      });

      const extension = result.bazaar;
      expect(extension.info.input.type).toBe("http");
      expect((extension.info as BodyDiscoveryInfo).input.bodyType).toBe("json");
      expect((extension.info as BodyDiscoveryInfo).input.body).toEqual({ name: "John", age: 30 });
    });

    it("should default to JSON body type if not specified", () => {
      const result = declareDiscoveryExtension({
        input: { data: "test" },
        inputSchema: {
          properties: {
            data: { type: "string" },
          },
        },
        bodyType: "json",
      });

      const extension = result.bazaar;
      expect((extension.info as BodyDiscoveryInfo).input.bodyType).toBe("json");
    });

    it("should support form-data body type", () => {
      const result = declareDiscoveryExtension({
        input: { file: "upload.pdf" },
        inputSchema: {
          properties: {
            file: { type: "string" },
          },
        },
        bodyType: "form-data",
      });

      const extension = result.bazaar;
      expect((extension.info as BodyDiscoveryInfo).input.bodyType).toBe("form-data");
    });
  });

  describe("declareDiscoveryExtension - Other methods", () => {
    it("should create a valid PUT extension", () => {
      const result = declareDiscoveryExtension({
        input: { id: "123", name: "Updated" },
        inputSchema: {
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
        },
        bodyType: "json",
      });

      const extension = result.bazaar;
      expect(extension.info.input.type).toBe("http");
    });

    it("should create a valid PATCH extension", () => {
      const result = declareDiscoveryExtension({
        input: { status: "active" },
        inputSchema: {
          properties: {
            status: { type: "string" },
          },
        },
        bodyType: "json",
      });

      const extension = result.bazaar;
      expect(extension.info.input.type).toBe("http");
    });

    it("should create a valid DELETE extension", () => {
      const result = declareDiscoveryExtension({
        input: { id: "123" },
        inputSchema: {
          properties: {
            id: { type: "string" },
          },
        },
      });

      const extension = result.bazaar;
      expect(extension.info.input.type).toBe("http");
    });

    it("should create a valid HEAD extension", () => {
      const result = declareDiscoveryExtension({});

      const extension = result.bazaar;
      expect(extension.info.input.type).toBe("http");
    });

    it("should throw error for unsupported method", () => {
      const result = declareDiscoveryExtension({});
      expect(result).toHaveProperty("bazaar");
    });
  });

  describe("validateDiscoveryExtension", () => {
    it("should validate a correct GET extension", () => {
      const declared = declareDiscoveryExtension({
        method: "GET",
        input: { query: "test" },
        inputSchema: {
          properties: {
            query: { type: "string" },
          },
        },
      });

      const extension = declared.bazaar;
      const result = validateDiscoveryExtension(extension);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it("should validate a correct POST extension", () => {
      const declared = declareDiscoveryExtension({
        method: "POST",
        input: { name: "John" },
        inputSchema: {
          properties: {
            name: { type: "string" },
          },
        },
        bodyType: "json",
      });

      const extension = declared.bazaar;
      const result = validateDiscoveryExtension(extension);
      expect(result.valid).toBe(true);
    });

    it("should fail validation when method is absent", () => {
      // Per spec, method is required. An extension without method (e.g. pre-enrichment)
      // must be rejected.
      const declared = declareDiscoveryExtension({
        input: { query: "test" },
        inputSchema: { properties: { query: { type: "string" } } },
      });

      const result = validateDiscoveryExtension(declared.bazaar);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes("method"))).toBe(true);
    });

    it("should detect invalid extension structure", () => {
      const invalidExtension = {
        info: {
          input: {
            type: "http",
            method: "GET",
          },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "invalid" }, // Should be "http"
                method: { type: "string", enum: ["GET"] },
              },
              required: ["type", "method"],
            },
          },
          required: ["input"],
        },
      } as unknown as DiscoveryExtension;

      const result = validateDiscoveryExtension(invalidExtension);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });
  });

  describe("extractDiscoveryInfoFromExtension", () => {
    it("should extract info from a valid extension", () => {
      const declared = declareDiscoveryExtension({
        method: "GET",
        input: { query: "test" },
        inputSchema: {
          properties: {
            query: { type: "string" },
          },
        },
      });

      const extension = declared.bazaar;
      const info = extractDiscoveryInfoFromExtension(extension);
      expect(info).toEqual(extension.info);
      expect(info.input.type).toBe("http");
    });

    it("should extract info without validation when validate=false", () => {
      const declared = declareDiscoveryExtension({
        input: { name: "John" },
        inputSchema: {
          properties: {
            name: { type: "string" },
          },
        },
        bodyType: "json",
      });

      const extension = declared.bazaar;
      const info = extractDiscoveryInfoFromExtension(extension, false);
      expect(info).toEqual(extension.info);
    });

    it("should throw error for invalid extension when validating", () => {
      const invalidExtension = {
        info: {
          input: {
            type: "http",
            method: "GET",
          },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "invalid" },
                method: { type: "string", enum: ["GET"] },
              },
              required: ["type", "method"],
            },
          },
          required: ["input"],
        },
      } as unknown as DiscoveryExtension;

      expect(() => {
        extractDiscoveryInfoFromExtension(invalidExtension);
      }).toThrow("Invalid discovery extension");
    });
  });

  describe("extractDiscoveryInfo (full flow)", () => {
    it("should extract info from v2 PaymentPayload with extensions", () => {
      const declared = declareDiscoveryExtension({
        method: "POST",
        input: { userId: "123" },
        inputSchema: {
          properties: {
            userId: { type: "string" },
          },
        },
        bodyType: "json",
      });

      const extension = declared.bazaar;

      const paymentPayload = {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
        accepted: {} as unknown,
        resource: { url: "http://example.com/test" },
        extensions: {
          [BAZAAR.key]: extension,
        },
      };

      const discovered = extractDiscoveryInfo(paymentPayload, {} as unknown);

      expect(discovered).not.toBeNull();
      expect(discovered!.discoveryInfo.input.type).toBe("http");
      expect(discovered!.resourceUrl).toBe("http://example.com/test");
    });

    it("should strip query params from v2 resourceUrl", () => {
      const declared = declareDiscoveryExtension({
        method: "GET",
        input: { city: "NYC" },
        inputSchema: {
          properties: {
            city: { type: "string" },
          },
        },
      });

      const extension = declared.bazaar;

      const paymentPayload = {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
        accepted: {} as unknown,
        resource: {
          url: "https://api.example.com/weather?city=NYC&units=metric",
          description: "Weather API",
          mimeType: "application/json",
        },
        extensions: {
          [BAZAAR.key]: extension,
        },
      };

      const discovered = extractDiscoveryInfo(paymentPayload, {} as unknown);

      expect(discovered).not.toBeNull();
      expect(discovered!.resourceUrl).toBe("https://api.example.com/weather");
      expect(discovered!.description).toBe("Weather API");
      expect(discovered!.mimeType).toBe("application/json");
    });

    it("should strip hash sections from v2 resourceUrl", () => {
      const declared = declareDiscoveryExtension({
        method: "GET",
        input: {},
        inputSchema: { properties: {} },
      });

      const extension = declared.bazaar;

      const paymentPayload = {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
        accepted: {} as unknown,
        resource: {
          url: "https://api.example.com/docs#section-1",
          description: "Docs",
          mimeType: "text/html",
        },
        extensions: {
          [BAZAAR.key]: extension,
        },
      };

      const discovered = extractDiscoveryInfo(paymentPayload, {} as unknown);

      expect(discovered).not.toBeNull();
      expect(discovered!.resourceUrl).toBe("https://api.example.com/docs");
    });

    it("should strip both query params and hash sections from v2 resourceUrl", () => {
      const declared = declareDiscoveryExtension({
        method: "GET",
        input: {},
        inputSchema: { properties: {} },
      });

      const extension = declared.bazaar;

      const paymentPayload = {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
        accepted: {} as unknown,
        resource: {
          url: "https://api.example.com/page?foo=bar#anchor",
          description: "Page",
          mimeType: "text/html",
        },
        extensions: {
          [BAZAAR.key]: extension,
        },
      };

      const discovered = extractDiscoveryInfo(paymentPayload, {} as unknown);

      expect(discovered).not.toBeNull();
      expect(discovered!.resourceUrl).toBe("https://api.example.com/page");
    });

    it("should extract info from v1 PaymentRequirements", () => {
      const v1Requirements = {
        scheme: "exact",
        network: "eip155:8453" as unknown,
        maxAmountRequired: "10000",
        resource: "https://api.example.com/data",
        description: "Get data",
        mimeType: "application/json",
        outputSchema: {
          input: {
            type: "http",
            method: "GET",
            discoverable: true,
            queryParams: { q: "test" },
          },
        },
        payTo: "0x...",
        maxTimeoutSeconds: 300,
        asset: "0x...",
        extra: {},
      };

      const v1Payload = {
        x402Version: 1,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
      };

      const discovered = extractDiscoveryInfo(v1Payload as unknown, v1Requirements as unknown);

      expect(discovered).not.toBeNull();
      expect(discovered!.discoveryInfo.input.method).toBe("GET");
      expect(discovered!.resourceUrl).toBe("https://api.example.com/data");
      expect(discovered!.method).toBe("GET");
      expect(discovered!.description).toBe("Get data");
      expect(discovered!.mimeType).toBe("application/json");
    });

    it("should strip query params from v1 resourceUrl", () => {
      const v1Requirements = {
        scheme: "exact",
        network: "eip155:8453" as unknown,
        maxAmountRequired: "10000",
        resource: "https://api.example.com/search?q=test&page=1",
        description: "Search",
        mimeType: "application/json",
        outputSchema: {
          input: {
            type: "http",
            method: "GET",
            discoverable: true,
            queryParams: { q: "string", page: "number" },
          },
        },
        payTo: "0x...",
        maxTimeoutSeconds: 300,
        asset: "0x...",
        extra: {},
      };

      const v1Payload = {
        x402Version: 1,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
      };

      const discovered = extractDiscoveryInfo(v1Payload as unknown, v1Requirements as unknown);

      expect(discovered).not.toBeNull();
      expect(discovered!.resourceUrl).toBe("https://api.example.com/search");
    });

    it("should strip hash sections from v1 resourceUrl", () => {
      const v1Requirements = {
        scheme: "exact",
        network: "eip155:8453" as unknown,
        maxAmountRequired: "10000",
        resource: "https://api.example.com/docs#section",
        description: "Docs",
        mimeType: "application/json",
        outputSchema: {
          input: {
            type: "http",
            method: "GET",
            discoverable: true,
          },
        },
        payTo: "0x...",
        maxTimeoutSeconds: 300,
        asset: "0x...",
        extra: {},
      };

      const v1Payload = {
        x402Version: 1,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
      };

      const discovered = extractDiscoveryInfo(v1Payload as unknown, v1Requirements as unknown);

      expect(discovered).not.toBeNull();
      expect(discovered!.resourceUrl).toBe("https://api.example.com/docs");
    });

    it("should return null when no discovery info is present", () => {
      const paymentPayload = {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
        accepted: {} as unknown,
      };

      const discovered = extractDiscoveryInfo(paymentPayload, {} as unknown);

      expect(discovered).toBeNull();
    });
  });

  describe("validateAndExtract", () => {
    it("should return valid result with info for correct extension", () => {
      const declared = declareDiscoveryExtension({
        method: "GET",
        input: { query: "test" },
        inputSchema: {
          properties: {
            query: { type: "string" },
          },
        },
      });

      const extension = declared.bazaar;
      const result = validateAndExtract(extension);
      expect(result.valid).toBe(true);
      expect(result.info).toEqual(extension.info);
      expect(result.errors).toBeUndefined();
    });

    it("should return invalid result with errors for incorrect extension", () => {
      const invalidExtension = {
        info: {
          input: {
            type: "http",
            method: "GET",
          },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "invalid" },
                method: { type: "string", enum: ["GET"] },
              },
              required: ["type", "method"],
            },
          },
          required: ["input"],
        },
      } as unknown as DiscoveryExtension;

      const result = validateAndExtract(invalidExtension);
      expect(result.valid).toBe(false);
      expect(result.info).toBeUndefined();
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });
  });

  describe("V1 Transformation", () => {
    it("should extract discovery info from v1 GET with no params", () => {
      const v1Requirements = {
        scheme: "exact",
        network: "eip155:8453" as unknown,
        maxAmountRequired: "100000",
        resource: "https://api.example.com/data",
        description: "Get data",
        mimeType: "application/json",
        outputSchema: {
          input: {
            type: "http",
            method: "GET",
            discoverable: true,
          },
          output: null,
        },
        payTo: "0x...",
        maxTimeoutSeconds: 300,
        asset: "0x...",
        extra: {},
      };

      const info = extractDiscoveryInfoV1(v1Requirements as unknown);
      expect(info).not.toBeNull();
      expect(info!.input.method).toBe("GET");
      expect(info!.input.type).toBe("http");
    });

    it("should extract discovery info from v1 GET with queryParams", () => {
      const v1Requirements = {
        scheme: "exact",
        network: "eip155:8453" as unknown,
        maxAmountRequired: "10000",
        resource: "https://api.example.com/list",
        description: "List items",
        mimeType: "application/json",
        outputSchema: {
          input: {
            discoverable: true,
            method: "GET",
            queryParams: {
              limit: "integer parameter",
              offset: "integer parameter",
            },
            type: "http",
          },
          output: { type: "array" },
        },
        payTo: "0x...",
        maxTimeoutSeconds: 300,
        asset: "0x...",
        extra: {},
      };

      const info = extractDiscoveryInfoV1(v1Requirements as unknown);
      expect(info).not.toBeNull();
      expect(info!.input.method).toBe("GET");
      expect(info!.input.queryParams).toEqual({
        limit: "integer parameter",
        offset: "integer parameter",
      });
    });

    it("should extract discovery info from v1 POST with bodyFields", () => {
      const v1Requirements = {
        scheme: "exact",
        network: "eip155:8453" as unknown,
        maxAmountRequired: "10000",
        resource: "https://api.example.com/search",
        description: "Search",
        mimeType: "application/json",
        outputSchema: {
          input: {
            bodyFields: {
              query: {
                description: "Search query",
                required: true,
                type: "string",
              },
            },
            bodyType: "json",
            discoverable: true,
            method: "POST",
            type: "http",
          },
        },
        payTo: "0x...",
        maxTimeoutSeconds: 120,
        asset: "0x...",
        extra: {},
      };

      const info = extractDiscoveryInfoV1(v1Requirements as unknown);
      expect(info).not.toBeNull();
      expect(info!.input.method).toBe("POST");
      expect((info as BodyDiscoveryInfo).input.bodyType).toBe("json");
      expect((info as BodyDiscoveryInfo).input.body).toEqual({
        query: {
          description: "Search query",
          required: true,
          type: "string",
        },
      });
    });

    it("should extract discovery info from v1 POST with snake_case fields", () => {
      const v1Requirements = {
        scheme: "exact",
        network: "eip155:8453" as unknown,
        maxAmountRequired: "1000",
        resource: "https://api.example.com/action",
        description: "Action",
        mimeType: "application/json",
        outputSchema: {
          input: {
            body_fields: null,
            body_type: null,
            discoverable: true,
            header_fields: {
              "X-Budget": {
                description: "Budget",
                required: false,
                type: "string",
              },
            },
            method: "POST",
            query_params: null,
            type: "http",
          },
          output: null,
        },
        payTo: "0x...",
        maxTimeoutSeconds: 60,
        asset: "0x...",
        extra: {},
      };

      const info = extractDiscoveryInfoV1(v1Requirements as unknown);
      expect(info).not.toBeNull();
      expect(info!.input.method).toBe("POST");
      expect(info!.input.headers).toEqual({
        "X-Budget": {
          description: "Budget",
          required: false,
          type: "string",
        },
      });
    });

    it("should extract discovery info from v1 POST with bodyParams", () => {
      const v1Requirements = {
        scheme: "exact",
        network: "eip155:8453" as unknown,
        maxAmountRequired: "50000",
        resource: "https://api.example.com/query",
        description: "Query",
        mimeType: "application/json",
        outputSchema: {
          input: {
            bodyParams: {
              question: {
                description: "Question",
                required: true,
                type: "string",
                maxLength: 500,
              },
            },
            discoverable: true,
            method: "POST",
            type: "http",
          },
        },
        payTo: "0x...",
        maxTimeoutSeconds: 300,
        asset: "0x...",
        extra: {},
      };

      const info = extractDiscoveryInfoV1(v1Requirements as unknown);
      expect(info).not.toBeNull();
      expect(info!.input.method).toBe("POST");
      expect((info as BodyDiscoveryInfo).input.body).toEqual({
        question: {
          description: "Question",
          required: true,
          type: "string",
          maxLength: 500,
        },
      });
    });

    it("should extract discovery info from v1 POST with properties field", () => {
      const v1Requirements = {
        scheme: "exact",
        network: "eip155:8453" as unknown,
        maxAmountRequired: "80000",
        resource: "https://api.example.com/chat",
        description: "Chat",
        mimeType: "application/json",
        outputSchema: {
          input: {
            discoverable: true,
            method: "POST",
            properties: {
              message: {
                description: "Message",
                type: "string",
              },
              stream: {
                description: "Stream",
                type: "boolean",
              },
            },
            required: ["message"],
            type: "http",
          },
        },
        payTo: "0x...",
        maxTimeoutSeconds: 60,
        asset: "0x...",
        extra: {},
      };

      const info = extractDiscoveryInfoV1(v1Requirements as unknown);
      expect(info).not.toBeNull();
      expect(info!.input.method).toBe("POST");
      expect((info as BodyDiscoveryInfo).input.body).toEqual({
        message: {
          description: "Message",
          type: "string",
        },
        stream: {
          description: "Stream",
          type: "boolean",
        },
      });
    });

    it("should handle v1 POST with no body content (minimal)", () => {
      const v1Requirements = {
        scheme: "exact",
        network: "eip155:8453" as unknown,
        maxAmountRequired: "10000",
        resource: "https://api.example.com/action",
        description: "Action",
        mimeType: "application/json",
        outputSchema: {
          input: {
            discoverable: true,
            method: "POST",
            type: "http",
          },
        },
        payTo: "0x...",
        maxTimeoutSeconds: 60,
        asset: "0x...",
        extra: {},
      };

      const info = extractDiscoveryInfoV1(v1Requirements as unknown);
      expect(info).not.toBeNull();
      expect(info!.input.method).toBe("POST");
      expect((info as BodyDiscoveryInfo).input.bodyType).toBe("json");
      expect((info as BodyDiscoveryInfo).input.body).toEqual({});
    });

    it("should skip non-discoverable endpoints", () => {
      const v1Requirements = {
        scheme: "exact",
        network: "eip155:8453" as unknown,
        maxAmountRequired: "10000",
        resource: "https://api.example.com/internal",
        description: "Internal",
        mimeType: "application/json",
        outputSchema: {
          input: {
            discoverable: false,
            method: "POST",
            type: "http",
          },
        },
        payTo: "0x...",
        maxTimeoutSeconds: 60,
        asset: "0x...",
        extra: {},
      };

      const info = extractDiscoveryInfoV1(v1Requirements as unknown);
      expect(info).toBeNull();
    });

    it("should handle missing outputSchema", () => {
      const v1Requirements = {
        scheme: "exact",
        network: "eip155:8453" as unknown,
        maxAmountRequired: "10000",
        resource: "https://api.example.com/resource",
        description: "Resource",
        mimeType: "application/json",
        outputSchema: {},
        payTo: "0x...",
        maxTimeoutSeconds: 60,
        asset: "0x...",
        extra: {},
      };

      const info = extractDiscoveryInfoV1(v1Requirements as unknown);
      expect(info).toBeNull();
    });
  });

  describe("Integration - Full workflow", () => {
    it("should handle GET endpoint with output schema (e2e scenario)", () => {
      const declared = declareDiscoveryExtension({
        method: "GET",
        input: {},
        inputSchema: {
          properties: {},
        },
        output: {
          example: {
            message: "Protected endpoint accessed successfully",
            timestamp: "2024-01-01T00:00:00Z",
          },
          schema: {
            properties: {
              message: { type: "string" },
              timestamp: { type: "string" },
            },
            required: ["message", "timestamp"],
          },
        },
      });

      const extension = declared.bazaar;

      const validation = validateDiscoveryExtension(extension);

      if (!validation.valid) {
        console.log("Validation errors:", validation.errors);
        console.log("Extension info:", extension.info);
        console.log("Extension schema:", extension.schema);
      }

      expect(validation.valid).toBe(true);

      const info = extractDiscoveryInfoFromExtension(extension, false);
      expect(info.input.type).toBe("http");
      expect(info.output?.example).toEqual({
        message: "Protected endpoint accessed successfully",
        timestamp: "2024-01-01T00:00:00Z",
      });
    });

    it("should handle complete v2 server-to-facilitator workflow", () => {
      const declared = declareDiscoveryExtension({
        method: "POST",
        input: { userId: "123", action: "create" },
        inputSchema: {
          properties: {
            userId: { type: "string" },
            action: { type: "string", enum: ["create", "update", "delete"] },
          },
          required: ["userId", "action"],
        },
        bodyType: "json",
        output: {
          example: { success: true, id: "new-id" },
        },
      });

      const extension = declared.bazaar;

      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: "/api/action",
          description: "Execute an action",
          mimeType: "application/json",
        },
        accepts: [],
        extensions: {
          [BAZAAR.key]: extension,
        },
      };

      const bazaarExt = paymentRequired.extensions?.[BAZAAR.key] as DiscoveryExtension;
      expect(bazaarExt).toBeDefined();

      const validation = validateDiscoveryExtension(bazaarExt);
      expect(validation.valid).toBe(true);

      const info = extractDiscoveryInfoFromExtension(bazaarExt, false);
      expect(info.input.type).toBe("http");
      expect((info as BodyDiscoveryInfo).input.bodyType).toBe("json");
      expect((info as BodyDiscoveryInfo).input.body).toEqual({ userId: "123", action: "create" });
      expect(info.output?.example).toEqual({ success: true, id: "new-id" });

      // Facilitator can now catalog this endpoint in the Bazaar
    });

    it("should handle v1-to-v2 transformation workflow", () => {
      // V1 PaymentRequirements from real Bazaar data
      const v1Requirements = {
        scheme: "exact",
        network: "eip155:8453" as unknown,
        maxAmountRequired: "10000",
        resource: "https://mesh.heurist.xyz/x402/agents/TokenResolverAgent/search",
        description: "Find tokens by address, ticker/symbol, or token name",
        mimeType: "application/json",
        outputSchema: {
          input: {
            bodyFields: {
              chain: {
                description: "Optional chain hint",
                type: "string",
              },
              query: {
                description: "Token search query",
                required: true,
                type: "string",
              },
              type_hint: {
                description: "Optional type hint",
                enum: ["address", "symbol", "name"],
                type: "string",
              },
            },
            bodyType: "json",
            discoverable: true,
            method: "POST",
            type: "http",
          },
        },
        payTo: "0x7d9d1821d15B9e0b8Ab98A058361233E255E405D",
        maxTimeoutSeconds: 120,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        extra: {},
      };

      const v1Payload = {
        x402Version: 1,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
      };

      const discovered = extractDiscoveryInfo(v1Payload as unknown, v1Requirements as unknown);

      expect(discovered).not.toBeNull();
      expect(discovered!.discoveryInfo.input.method).toBe("POST");
      expect(discovered!.method).toBe("POST");
      expect((discovered!.discoveryInfo as BodyDiscoveryInfo).input.bodyType).toBe("json");
      expect((discovered!.discoveryInfo as BodyDiscoveryInfo).input.body).toHaveProperty("query");
      expect((discovered!.discoveryInfo as BodyDiscoveryInfo).input.body).toHaveProperty("chain");
      expect((discovered!.discoveryInfo as BodyDiscoveryInfo).input.body).toHaveProperty(
        "type_hint",
      );
    });

    it("should handle unified extraction for both v1 and v2", () => {
      const declared = declareDiscoveryExtension({
        method: "GET",
        input: { limit: 10 },
        inputSchema: {
          properties: {
            limit: { type: "number" },
          },
        },
      });

      const v2Extension = declared.bazaar;

      const v2Payload = {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
        accepted: {} as unknown,
        resource: { url: "http://example.com/v2" },
        extensions: {
          [BAZAAR.key]: v2Extension,
        },
      };

      const v2Discovered = extractDiscoveryInfo(v2Payload, {} as unknown);

      expect(v2Discovered).not.toBeNull();
      expect(v2Discovered!.discoveryInfo.input.type).toBe("http");
      expect(v2Discovered!.resourceUrl).toBe("http://example.com/v2");

      const v1Requirements = {
        scheme: "exact",
        network: "eip155:8453" as unknown,
        maxAmountRequired: "10000",
        resource: "https://api.example.com/list",
        description: "List",
        mimeType: "application/json",
        outputSchema: {
          input: {
            discoverable: true,
            method: "GET",
            queryParams: { limit: "number" },
            type: "http",
          },
        },
        payTo: "0x...",
        maxTimeoutSeconds: 300,
        asset: "0x...",
        extra: {},
      };

      const v1Payload = {
        x402Version: 1,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
      };

      const v1Discovered = extractDiscoveryInfo(v1Payload as unknown, v1Requirements as unknown);

      expect(v1Discovered).not.toBeNull();
      expect(v1Discovered!.method).toBe("GET");
      expect(v1Discovered!.resourceUrl).toBe("https://api.example.com/list");

      expect(typeof v2Discovered!.discoveryInfo.input).toBe(
        typeof v1Discovered!.discoveryInfo.input,
      );
    });
  });

  describe("bazaarResourceServerExtension", () => {
    // Helper to extract method enum from schema
    const extractMethodEnum = (schema: Record<string, unknown>): string[] => {
      const props = schema.properties as Record<string, unknown>;
      const input = props.input as Record<string, unknown>;
      const inputProps = input.properties as Record<string, unknown>;
      const method = inputProps.method as Record<string, unknown>;
      return method.enum as string[];
    };

    // Helper to extract required fields from schema
    const extractRequiredFields = (schema: Record<string, unknown>): string[] => {
      const props = schema.properties as Record<string, unknown>;
      const input = props.input as Record<string, unknown>;
      return input.required as string[];
    };

    // Mock adapter for testing
    const createMockAdapter = (): HTTPAdapter => ({
      getHeader: () => undefined,
      getMethod: () => "POST",
      getPath: () => "/test",
      getUrl: () => "http://localhost/test",
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "test-agent",
    });

    it("should narrow method enum in schema for POST request", () => {
      const declared = declareDiscoveryExtension({
        input: { prompt: "test" },
        inputSchema: { properties: { prompt: { type: "string" } } },
        bodyType: "json",
      });

      const extension = declared.bazaar;

      // Before enrichment, schema has broad enum
      const beforeEnum = extractMethodEnum(extension.schema as Record<string, unknown>);
      expect(beforeEnum).toEqual(["POST", "PUT", "PATCH"]);

      const httpContext: HTTPRequestContext = {
        method: "POST",
        path: "/test",
        adapter: createMockAdapter(),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as DiscoveryExtension;

      // After enrichment, schema should have narrow enum
      const afterEnum = extractMethodEnum(enriched.schema as Record<string, unknown>);
      expect(afterEnum).toEqual(["POST"]);
    });

    it("should narrow method enum in schema for GET request", () => {
      const declared = declareDiscoveryExtension({
        input: { query: "test" },
        inputSchema: { properties: { query: { type: "string" } } },
      });

      const extension = declared.bazaar;

      // Before enrichment, schema has broad enum
      const beforeEnum = extractMethodEnum(extension.schema as Record<string, unknown>);
      expect(beforeEnum).toEqual(["GET", "HEAD", "DELETE"]);

      const httpContext: HTTPRequestContext = {
        method: "GET",
        path: "/test",
        adapter: createMockAdapter(),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as DiscoveryExtension;

      // After enrichment, schema should have narrow enum
      const afterEnum = extractMethodEnum(enriched.schema as Record<string, unknown>);
      expect(afterEnum).toEqual(["GET"]);
    });

    it("should enrich declaration with method in info.input", () => {
      const declared = declareDiscoveryExtension({
        input: { data: "test" },
        inputSchema: { properties: { data: { type: "string" } } },
        bodyType: "json",
      });

      const extension = declared.bazaar;

      const httpContext: HTTPRequestContext = {
        method: "POST",
        path: "/test",
        adapter: createMockAdapter(),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as DiscoveryExtension;

      // Method should be set in info.input
      expect((enriched.info as BodyDiscoveryInfo).input.method).toBe("POST");
    });

    it("should add method to required array if not already present", () => {
      const declared = declareDiscoveryExtension({
        input: { prompt: "test" },
        inputSchema: { properties: { prompt: { type: "string" } } },
        bodyType: "json",
      });

      const extension = declared.bazaar;

      const httpContext: HTTPRequestContext = {
        method: "POST",
        path: "/test",
        adapter: createMockAdapter(),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as DiscoveryExtension;

      const required = extractRequiredFields(enriched.schema as Record<string, unknown>);
      expect(required).toContain("method");
    });

    it("should produce a valid extension after enrichment (GET)", () => {
      const declared = declareDiscoveryExtension({
        input: { query: "test" },
        inputSchema: { properties: { query: { type: "string" } } },
      });

      // Pre-enrichment: method not set, validation should fail
      const preResult = validateDiscoveryExtension(declared.bazaar);
      expect(preResult.valid).toBe(false);

      const httpContext: HTTPRequestContext = {
        method: "GET",
        path: "/test",
        adapter: createMockAdapter(),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        declared.bazaar,
        httpContext,
      ) as DiscoveryExtension;

      // Post-enrichment: validation should pass
      const postResult = validateDiscoveryExtension(enriched);
      expect(postResult.valid).toBe(true);
    });

    it("should produce a valid extension after enrichment (POST)", () => {
      const declared = declareDiscoveryExtension({
        input: { data: "test" },
        inputSchema: { properties: { data: { type: "string" } } },
        bodyType: "json",
      });

      const preResult = validateDiscoveryExtension(declared.bazaar);
      expect(preResult.valid).toBe(false);

      const httpContext: HTTPRequestContext = {
        method: "POST",
        path: "/test",
        adapter: createMockAdapter(),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        declared.bazaar,
        httpContext,
      ) as DiscoveryExtension;

      const postResult = validateDiscoveryExtension(enriched);
      expect(postResult.valid).toBe(true);
    });

    it("should return unchanged declaration for non-HTTP context", () => {
      const declared = declareDiscoveryExtension({
        input: { data: "test" },
        inputSchema: { properties: { data: { type: "string" } } },
        bodyType: "json",
      });

      const extension = declared.bazaar;

      // Non-HTTP context (missing adapter property)
      const nonHTTPContext = { method: "POST" };

      const result = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        nonHTTPContext,
      ) as DiscoveryExtension;

      // Should return unchanged - schema still has broad enum
      const methodEnum = extractMethodEnum(result.schema as Record<string, unknown>);
      expect(methodEnum).toEqual(["POST", "PUT", "PATCH"]);
    });
  });

  describe("declareDiscoveryExtension - MCP tool", () => {
    it("should create a valid MCP extension with tool info", () => {
      const result = declareDiscoveryExtension({
        toolName: "financial_analysis",
        description: "Analyze financial data for a given ticker",
        inputSchema: {
          type: "object",
          properties: {
            ticker: { type: "string", description: "Stock ticker symbol" },
            analysis_type: {
              type: "string",
              enum: ["fundamental", "technical", "sentiment"],
            },
          },
          required: ["ticker"],
        },
        example: { ticker: "AAPL", analysis_type: "fundamental" },
      });

      expect(result).toHaveProperty("bazaar");
      const extension = result.bazaar;
      expect(extension).toHaveProperty("info");
      expect(extension).toHaveProperty("schema");
      expect(extension.info.input.type).toBe("mcp");
      expect((extension.info as McpDiscoveryInfo).input.toolName).toBe("financial_analysis");
      expect((extension.info as McpDiscoveryInfo).input.description).toBe(
        "Analyze financial data for a given ticker",
      );
      expect((extension.info as McpDiscoveryInfo).input.inputSchema).toBeDefined();
      expect((extension.info as McpDiscoveryInfo).input.example).toEqual({
        ticker: "AAPL",
        analysis_type: "fundamental",
      });
    });

    it("should create an MCP extension without optional fields", () => {
      const result = declareDiscoveryExtension({
        toolName: "simple_tool",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      });

      const extension = result.bazaar;
      expect(extension.info.input.type).toBe("mcp");
      expect((extension.info as McpDiscoveryInfo).input.toolName).toBe("simple_tool");
      expect((extension.info as McpDiscoveryInfo).input.description).toBeUndefined();
      expect((extension.info as McpDiscoveryInfo).input.example).toBeUndefined();
    });

    it("should create an MCP extension with transport field", () => {
      const result = declareDiscoveryExtension({
        toolName: "streaming_tool",
        transport: "sse",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      });

      const extension = result.bazaar;
      expect(extension.info.input.type).toBe("mcp");
      expect((extension.info as McpDiscoveryInfo).input.transport).toBe("sse");
    });

    it("should omit transport when not provided (defaults to streamable-http per spec)", () => {
      const result = declareDiscoveryExtension({
        toolName: "default_transport_tool",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      });

      const extension = result.bazaar;
      expect((extension.info as McpDiscoveryInfo).input.transport).toBeUndefined();
    });

    it("should create an MCP extension with output example", () => {
      const result = declareDiscoveryExtension({
        toolName: "weather_tool",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
        },
        output: {
          example: { temperature: 72, condition: "sunny" },
        },
      });

      const extension = result.bazaar;
      expect(extension.info.output?.example).toEqual({ temperature: 72, condition: "sunny" });
    });
  });

  describe("validateDiscoveryExtension - MCP", () => {
    it("should validate a correct MCP extension", () => {
      const declared = declareDiscoveryExtension({
        toolName: "my_tool",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      });

      const extension = declared.bazaar;
      const result = validateDiscoveryExtension(extension);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it("should validate an MCP extension with all optional fields", () => {
      const declared = declareDiscoveryExtension({
        toolName: "full_tool",
        description: "A fully specified tool",
        transport: "streamable-http",
        inputSchema: {
          type: "object",
          properties: {
            input: { type: "string" },
          },
          required: ["input"],
        },
        example: { input: "test" },
        output: {
          example: { result: "success" },
        },
      });

      const extension = declared.bazaar;
      const result = validateDiscoveryExtension(extension);
      expect(result.valid).toBe(true);
    });
  });

  describe("extractDiscoveryInfo - MCP", () => {
    it("should extract MCP discovery info with tool name as method", () => {
      const declared = declareDiscoveryExtension({
        toolName: "financial_analysis",
        description: "Analyze financial data",
        inputSchema: {
          type: "object",
          properties: {
            ticker: { type: "string" },
          },
        },
      });

      const extension = declared.bazaar;

      const paymentPayload = {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
        accepted: {} as unknown,
        resource: {
          url: "https://mcp.example.com/tools",
          description: "MCP Tool Server",
          mimeType: "application/json",
        },
        extensions: {
          [BAZAAR.key]: extension,
        },
      };

      const discovered = extractDiscoveryInfo(paymentPayload, {} as unknown);

      expect(discovered).not.toBeNull();
      expect(discovered!.discoveryInfo.input.type).toBe("mcp");
      expect((discovered as DiscoveredMCPResource).toolName).toBe("financial_analysis");
      expect(discovered!.resourceUrl).toBe("https://mcp.example.com/tools");
      expect(discovered!.description).toBe("MCP Tool Server");
    });

    it("should strip query params from MCP resource URL", () => {
      const declared = declareDiscoveryExtension({
        toolName: "search",
        inputSchema: { type: "object", properties: {} },
      });

      const extension = declared.bazaar;

      const paymentPayload = {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
        accepted: {} as unknown,
        resource: {
          url: "https://mcp.example.com/tools?session=abc",
        },
        extensions: {
          [BAZAAR.key]: extension,
        },
      };

      const discovered = extractDiscoveryInfo(paymentPayload, {} as unknown);

      expect(discovered).not.toBeNull();
      expect(discovered!.resourceUrl).toBe("https://mcp.example.com/tools");
    });
  });

  describe("validateAndExtract - MCP", () => {
    it("should validate and extract MCP discovery info", () => {
      const declared = declareDiscoveryExtension({
        toolName: "code_review",
        description: "Review code changes",
        inputSchema: {
          type: "object",
          properties: {
            diff: { type: "string" },
            language: { type: "string" },
          },
          required: ["diff"],
        },
        example: { diff: "--- a/file.ts\n+++ b/file.ts", language: "typescript" },
      });

      const extension = declared.bazaar;
      const result = validateAndExtract(extension);
      expect(result.valid).toBe(true);
      expect(result.info).toBeDefined();
      expect(result.info!.input.type).toBe("mcp");
    });
  });

  describe("extractDiscoveryInfoFromExtension - MCP", () => {
    it("should extract info from a valid MCP extension", () => {
      const declared = declareDiscoveryExtension({
        toolName: "translate",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            target_language: { type: "string" },
          },
        },
      });

      const extension = declared.bazaar;
      const info = extractDiscoveryInfoFromExtension(extension);
      expect(info).toEqual(extension.info);
      expect(info.input.type).toBe("mcp");
    });
  });

  describe("bazaarResourceServerExtension - MCP", () => {
    it("should not modify MCP extensions even with HTTP context", () => {
      const declared = declareDiscoveryExtension({
        toolName: "my_tool",
        description: "A tool",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      });

      const extension = declared.bazaar;

      const mockAdapter: HTTPAdapter = {
        getMethod: () => "POST",
        getUrl: () => new URL("http://localhost/test"),
        getHeader: () => undefined,
        setHeader: () => {},
        setStatusCode: () => {},
        setBody: () => {},
        getBody: () => ({}),
      };

      const httpContext: HTTPRequestContext = {
        method: "POST",
        path: "/test",
        adapter: mockAdapter,
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as DiscoveryExtension;

      // MCP extension should remain unchanged
      expect(enriched.info.input.type).toBe("mcp");
      expect((enriched.info as McpDiscoveryInfo).input.toolName).toBe("my_tool");
    });
  });

  describe("dynamic routes", () => {
    const createMockAdapterWithPath = (path: string): HTTPAdapter => ({
      getHeader: () => undefined,
      getMethod: () => "GET",
      getPath: () => path,
      getUrl: () => `http://example.com${path}`,
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "test-agent",
    });

    it("should leave static routes unchanged", () => {
      const declared = declareDiscoveryExtension({
        input: { query: "test" },
        inputSchema: { properties: { query: { type: "string" } } },
      });
      const extension = declared.bazaar;

      const httpContext: HTTPRequestContext = {
        method: "GET",
        path: "/users",
        routePattern: "/users",
        adapter: createMockAdapterWithPath("/users"),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as Record<string, unknown>;

      expect(enriched.routeTemplate).toBeUndefined();
    });

    it("should produce routeTemplate for dynamic routes", () => {
      const declared = declareDiscoveryExtension({
        input: {},
        inputSchema: { properties: {} },
      });
      const extension = declared.bazaar;

      const httpContext: HTTPRequestContext = {
        method: "GET",
        path: "/users/123",
        routePattern: "/users/[userId]",
        adapter: createMockAdapterWithPath("/users/123"),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as Record<string, unknown>;

      expect(enriched.routeTemplate).toBe("/users/:userId");
    });

    it("should extract path params from concrete URL", () => {
      const declared = declareDiscoveryExtension({
        input: {},
        inputSchema: { properties: {} },
      });
      const extension = declared.bazaar;

      const httpContext: HTTPRequestContext = {
        method: "GET",
        path: "/users/123",
        routePattern: "/users/[userId]",
        adapter: createMockAdapterWithPath("/users/123"),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as Record<string, unknown>;

      const info = enriched.info as Record<string, unknown>;
      const input = info.input as Record<string, unknown>;
      expect(input.pathParams).toEqual({ userId: "123" });
    });

    it("should extract multiple path params", () => {
      const declared = declareDiscoveryExtension({
        input: {},
        inputSchema: { properties: {} },
      });
      const extension = declared.bazaar;

      const httpContext: HTTPRequestContext = {
        method: "GET",
        path: "/users/42/posts/7",
        routePattern: "/users/[userId]/posts/[postId]",
        adapter: createMockAdapterWithPath("/users/42/posts/7"),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as Record<string, unknown>;

      expect(enriched.routeTemplate).toBe("/users/:userId/posts/:postId");
      const info = enriched.info as Record<string, unknown>;
      const input = info.input as Record<string, unknown>;
      expect(input.pathParams).toEqual({ userId: "42", postId: "7" });
    });

    it("should use routeTemplate for canonical URL in facilitator", () => {
      const declared = declareDiscoveryExtension({
        input: {},
        inputSchema: { properties: {} },
      });
      const extension = declared.bazaar;
      // Simulate enriched extension with routeTemplate
      const enrichedExtension = {
        ...extension,
        routeTemplate: "/users/:userId",
        info: {
          ...extension.info,
          input: { ...extension.info.input, pathParams: { userId: "123" } },
        },
      };

      const paymentPayload = {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
        accepted: {} as unknown,
        resource: { url: "http://example.com/users/123" },
        extensions: {
          [BAZAAR.key]: enrichedExtension,
        },
      };

      const discovered = extractDiscoveryInfo(paymentPayload, {} as unknown, false);

      expect(discovered).not.toBeNull();
      expect(discovered!.resourceUrl).toBe("http://example.com/users/:userId");
      // Narrow to DiscoveredHTTPResource to access routeTemplate (HTTP-only field)
      expect((discovered as import("./..").DiscoveredHTTPResource).routeTemplate).toBe(
        "/users/:userId",
      );
    });

    it("should return empty pathParams when URL path does not match pattern structure", () => {
      const declared = declareDiscoveryExtension({
        input: {},
        inputSchema: { properties: {} },
      });
      const extension = declared.bazaar;

      // Pattern expects /users/[userId] but path is /api/other — structurally mismatched.
      // This can occur in production if middleware and extension patterns diverge.
      const httpContext: HTTPRequestContext = {
        method: "GET",
        path: "/api/other",
        routePattern: "/users/[userId]",
        adapter: createMockAdapterWithPath("/api/other"),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as Record<string, unknown>;

      const info = enriched.info as Record<string, unknown>;
      const input = info.input as Record<string, unknown>;
      // extractPathParams returns {} gracefully when pattern and URL structure don't match
      expect(input.pathParams).toEqual({});
    });

    it("should produce routeTemplate for :param style routes", () => {
      const declared = declareDiscoveryExtension({
        input: {},
        inputSchema: { properties: {} },
      });
      const extension = declared.bazaar;

      const httpContext: HTTPRequestContext = {
        method: "GET",
        path: "/users/123",
        routePattern: "/users/:userId",
        adapter: createMockAdapterWithPath("/users/123"),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as Record<string, unknown>;

      expect(enriched.routeTemplate).toBe("/users/:userId");
    });

    it("should extract path params from :param style routes", () => {
      const declared = declareDiscoveryExtension({
        input: {},
        inputSchema: { properties: {} },
      });
      const extension = declared.bazaar;

      const httpContext: HTTPRequestContext = {
        method: "GET",
        path: "/users/42/posts/7",
        routePattern: "/users/:userId/posts/:postId",
        adapter: createMockAdapterWithPath("/users/42/posts/7"),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as Record<string, unknown>;

      expect(enriched.routeTemplate).toBe("/users/:userId/posts/:postId");
      const info = enriched.info as Record<string, unknown>;
      const input = info.input as Record<string, unknown>;
      expect(input.pathParams).toEqual({ userId: "42", postId: "7" });
    });

    it("should auto-convert wildcard * to :varN for discovery", () => {
      const declared = declareDiscoveryExtension({
        input: {},
        inputSchema: { properties: {} },
      });
      const extension = declared.bazaar;

      const httpContext: HTTPRequestContext = {
        method: "GET",
        path: "/weather/san-francisco",
        routePattern: "/weather/*",
        adapter: createMockAdapterWithPath("/weather/san-francisco"),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as Record<string, unknown>;

      expect(enriched.routeTemplate).toBe("/weather/:var1");
      const info = enriched.info as Record<string, unknown>;
      const input = info.input as Record<string, unknown>;
      expect(input.pathParams).toEqual({ var1: "san-francisco" });
    });

    it("should auto-convert multiple wildcards to :var1, :var2, etc.", () => {
      const declared = declareDiscoveryExtension({
        input: {},
        inputSchema: { properties: {} },
      });
      const extension = declared.bazaar;

      const httpContext: HTTPRequestContext = {
        method: "GET",
        path: "/api/users/42/posts/7",
        routePattern: "/api/*/*/posts/*",
        adapter: createMockAdapterWithPath("/api/users/42/posts/7"),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as Record<string, unknown>;

      expect(enriched.routeTemplate).toBe("/api/:var1/:var2/posts/:var3");
    });

    it("should handle mixed [param] and :param patterns", () => {
      const declared = declareDiscoveryExtension({
        input: {},
        inputSchema: { properties: {} },
      });
      const extension = declared.bazaar;

      const httpContext: HTTPRequestContext = {
        method: "GET",
        path: "/users/42/posts/7",
        routePattern: "/users/[userId]/posts/:postId",
        adapter: createMockAdapterWithPath("/users/42/posts/7"),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as Record<string, unknown>;

      expect(enriched.routeTemplate).toBe("/users/:userId/posts/:postId");
      const info = enriched.info as Record<string, unknown>;
      const input = info.input as Record<string, unknown>;
      expect(input.pathParams).toEqual({ userId: "42", postId: "7" });
    });

    it("should pass schema validation after enrichment with auto-injected pathParams", () => {
      const declared = declareDiscoveryExtension({
        input: {},
        inputSchema: { properties: {} },
      });
      const extension = declared.bazaar;

      const httpContext: HTTPRequestContext = {
        method: "GET",
        path: "/users/123",
        routePattern: "/users/:userId",
        adapter: createMockAdapterWithPath("/users/123"),
      };

      const enriched = bazaarResourceServerExtension.enrichDeclaration!(
        extension,
        httpContext,
      ) as import("../src/bazaar/http/types").QueryDiscoveryExtension;

      const result = validateDiscoveryExtension(enriched);
      expect(result.valid).toBe(true);
    });

    it("should use concrete URL for static routes in facilitator", () => {
      const declared = declareDiscoveryExtension({
        input: { query: "test" },
        inputSchema: { properties: { query: { type: "string" } } },
      });
      const extension = declared.bazaar;

      const paymentPayload = {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453" as unknown,
        payload: {},
        accepted: {} as unknown,
        resource: { url: "http://example.com/search?q=test" },
        extensions: {
          [BAZAAR.key]: extension,
        },
      };

      const discovered = extractDiscoveryInfo(paymentPayload, {} as unknown, false);

      expect(discovered).not.toBeNull();
      expect(discovered!.resourceUrl).toBe("http://example.com/search");
      // Narrow to DiscoveredHTTPResource to access routeTemplate (HTTP-only field)
      expect((discovered as import("./..").DiscoveredHTTPResource).routeTemplate).toBeUndefined();
    });
  });

  describe("isValidRouteTemplate", () => {
    it("returns false for empty string", () => {
      expect(isValidRouteTemplate("")).toBe(false);
    });

    it("returns false for undefined input", () => {
      expect(isValidRouteTemplate(undefined)).toBe(false);
    });

    it("returns false for paths not starting with /", () => {
      expect(isValidRouteTemplate("users/123")).toBe(false);
      expect(isValidRouteTemplate("relative/path")).toBe(false);
      expect(isValidRouteTemplate("no-slash")).toBe(false);
    });

    it("returns false for paths containing ..", () => {
      expect(isValidRouteTemplate("/users/../admin")).toBe(false);
      expect(isValidRouteTemplate("/../etc/passwd")).toBe(false);
      expect(isValidRouteTemplate("/users/..")).toBe(false);
    });

    it("returns false for paths containing ://", () => {
      expect(isValidRouteTemplate("http://evil.com/path")).toBe(false);
      expect(isValidRouteTemplate("/users/http://evil")).toBe(false);
      expect(isValidRouteTemplate("javascript://foo")).toBe(false);
    });

    it("returns true for valid paths", () => {
      expect(isValidRouteTemplate("/users/:userId")).toBe(true);
      expect(isValidRouteTemplate("/api/v1/items")).toBe(true);
      expect(isValidRouteTemplate("/products/:productId/reviews/:reviewId")).toBe(true);
      expect(isValidRouteTemplate("/weather/:country/:city")).toBe(true);
    });

    it("rejects paths with spaces or invalid characters", () => {
      expect(isValidRouteTemplate("/users/ bad")).toBe(false);
      expect(isValidRouteTemplate("/path with spaces")).toBe(false);
    });

    it("rejects /users/..hidden because it contains '..' as a substring", () => {
      expect(isValidRouteTemplate("/users/..hidden")).toBe(false);
    });

    it("rejects percent-encoded traversal sequences", () => {
      expect(isValidRouteTemplate("/users/%2e%2e/admin")).toBe(false);
      expect(isValidRouteTemplate("/users/%2E%2E/admin")).toBe(false);
    });
  });
});
