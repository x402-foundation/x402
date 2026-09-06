import { describe, it, expect } from "vitest";
import type { PaymentPayload } from "@x402/core";
import {
  PAYMENT_IDENTIFIER,
  PAYMENT_ID_MIN_LENGTH,
  PAYMENT_ID_MAX_LENGTH,
  PAYMENT_ID_PATTERN,
  generatePaymentId,
  isValidPaymentId,
  appendPaymentIdentifierToExtensions,
  declarePaymentIdentifierExtension,
  paymentIdentifierResourceServerExtension,
  validatePaymentIdentifier,
  extractPaymentIdentifier,
  extractAndValidatePaymentIdentifier,
  hasPaymentIdentifier,
  isPaymentIdentifierExtension,
  isPaymentIdentifierRequired,
  validatePaymentIdentifierRequirement,
  paymentIdentifierSchema,
} from "../src/payment-identifier";

/**
 * Helper to create an extension with ID appended (mimics client flow)
 *
 * @param id - Optional payment ID to use. If not provided, a new ID will be generated.
 * @param required - Whether the payment identifier is required (defaults to false).
 * @returns The payment-identifier extension object with the ID appended.
 */
function createExtensionWithId(id?: string, required: boolean = false) {
  const extensions: Record<string, unknown> = {
    [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(required),
  };
  appendPaymentIdentifierToExtensions(extensions, id);
  return extensions[PAYMENT_IDENTIFIER];
}

describe("Payment-Identifier Extension", () => {
  describe("Constants", () => {
    it("should export the correct extension key", () => {
      expect(PAYMENT_IDENTIFIER).toBe("payment-identifier");
    });

    it("should export correct length constraints", () => {
      expect(PAYMENT_ID_MIN_LENGTH).toBe(16);
      expect(PAYMENT_ID_MAX_LENGTH).toBe(128);
    });

    it("should export correct pattern", () => {
      expect(PAYMENT_ID_PATTERN).toBeInstanceOf(RegExp);
      expect(PAYMENT_ID_PATTERN.test("valid_id_123")).toBe(true);
      expect(PAYMENT_ID_PATTERN.test("invalid!@#")).toBe(false);
    });
  });

  describe("generatePaymentId", () => {
    it("should generate an ID with default prefix", () => {
      const id = generatePaymentId();
      expect(id).toMatch(/^pay_[a-f0-9]{32}$/);
    });

    it("should generate an ID with custom prefix", () => {
      const id = generatePaymentId("txn_");
      expect(id).toMatch(/^txn_[a-f0-9]{32}$/);
    });

    it("should generate an ID without prefix when empty string provided", () => {
      const id = generatePaymentId("");
      expect(id).toMatch(/^[a-f0-9]{32}$/);
    });

    it("should generate unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generatePaymentId());
      }
      expect(ids.size).toBe(100);
    });

    it("should generate IDs that pass validation", () => {
      const id = generatePaymentId();
      expect(isValidPaymentId(id)).toBe(true);
    });
  });

  describe("isValidPaymentId", () => {
    it("should accept valid IDs", () => {
      expect(isValidPaymentId("pay_7d5d747be160e280")).toBe(true);
      expect(isValidPaymentId("1234567890123456")).toBe(true);
      expect(isValidPaymentId("abcdefghijklmnop")).toBe(true);
      expect(isValidPaymentId("test_with-hyphens")).toBe(true);
      expect(isValidPaymentId("test_with_underscores")).toBe(true);
    });

    it("should reject IDs that are too short", () => {
      expect(isValidPaymentId("abc")).toBe(false);
      expect(isValidPaymentId("123456789012345")).toBe(false); // 15 chars
    });

    it("should reject IDs that are too long", () => {
      const longId = "a".repeat(129);
      expect(isValidPaymentId(longId)).toBe(false);
    });

    it("should accept IDs at boundary lengths", () => {
      const minId = "a".repeat(16);
      const maxId = "a".repeat(128);
      expect(isValidPaymentId(minId)).toBe(true);
      expect(isValidPaymentId(maxId)).toBe(true);
    });

    it("should reject IDs with invalid characters", () => {
      expect(isValidPaymentId("pay_abc!@#$%^&*()")).toBe(false);
      expect(isValidPaymentId("pay_abc def ghij")).toBe(false);
      expect(isValidPaymentId("pay_abc.def.ghij")).toBe(false);
    });

    it("should reject non-string values", () => {
      expect(isValidPaymentId(null as unknown as string)).toBe(false);
      expect(isValidPaymentId(undefined as unknown as string)).toBe(false);
      expect(isValidPaymentId(123 as unknown as string)).toBe(false);
    });
  });

  describe("appendPaymentIdentifierToExtensions", () => {
    it("should append auto-generated ID when extension exists", () => {
      const extensions: Record<string, unknown> = {
        [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(),
      };
      const result = appendPaymentIdentifierToExtensions(extensions);

      expect(result).toBe(extensions); // Same reference
      const ext = extensions[PAYMENT_IDENTIFIER] as { info: { required: boolean; id?: string } };
      expect(ext.info.id).toMatch(/^pay_[a-f0-9]{32}$/);
      expect(ext.info.required).toBe(false);
    });

    it("should append custom ID when extension exists", () => {
      const customId = "custom_id_1234567890";
      const extensions: Record<string, unknown> = {
        [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(),
      };
      appendPaymentIdentifierToExtensions(extensions, customId);

      const ext = extensions[PAYMENT_IDENTIFIER] as { info: { required: boolean; id?: string } };
      expect(ext.info.id).toBe(customId);
    });

    it("should preserve required=true from server declaration", () => {
      const extensions: Record<string, unknown> = {
        [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true),
      };
      appendPaymentIdentifierToExtensions(extensions);

      const ext = extensions[PAYMENT_IDENTIFIER] as { info: { required: boolean; id?: string } };
      expect(ext.info.required).toBe(true);
      expect(ext.info.id).toMatch(/^pay_[a-f0-9]{32}$/);
    });

    it("should not modify extensions when payment-identifier is not present", () => {
      const extensions: Record<string, unknown> = { other: { foo: "bar" } };
      const result = appendPaymentIdentifierToExtensions(extensions);

      expect(result).toBe(extensions);
      expect(extensions[PAYMENT_IDENTIFIER]).toBeUndefined();
      expect(extensions.other).toEqual({ foo: "bar" });
    });

    it("should not modify extensions when payment-identifier has no info", () => {
      const extensions: Record<string, unknown> = {
        [PAYMENT_IDENTIFIER]: { schema: paymentIdentifierSchema },
      };
      const result = appendPaymentIdentifierToExtensions(extensions);

      expect(result).toBe(extensions);
      const ext = extensions[PAYMENT_IDENTIFIER] as { info?: unknown };
      expect(ext.info).toBeUndefined();
    });

    it("should throw error for invalid custom ID", () => {
      const extensions: Record<string, unknown> = {
        [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(),
      };
      expect(() => appendPaymentIdentifierToExtensions(extensions, "short")).toThrow();
      expect(() => appendPaymentIdentifierToExtensions(extensions, "invalid!@#$%^&")).toThrow();
    });

    it("should not throw when extension doesn't exist and custom ID provided", () => {
      const extensions: Record<string, unknown> = { other: {} };
      const result = appendPaymentIdentifierToExtensions(extensions, "valid_id_12345678");
      expect(result).toBe(extensions);
      expect(extensions[PAYMENT_IDENTIFIER]).toBeUndefined();
    });

    it("should overwrite existing id if called multiple times", () => {
      const extensions: Record<string, unknown> = {
        [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(),
      };
      appendPaymentIdentifierToExtensions(extensions, "first_id_12345678");
      const ext1 = extensions[PAYMENT_IDENTIFIER] as { info: { id?: string } };
      expect(ext1.info.id).toBe("first_id_12345678");

      appendPaymentIdentifierToExtensions(extensions, "second_id_12345678");
      const ext2 = extensions[PAYMENT_IDENTIFIER] as { info: { id?: string } };
      expect(ext2.info.id).toBe("second_id_12345678");
    });
  });

  describe("declarePaymentIdentifierExtension", () => {
    it("should return a declaration with required=false by default", () => {
      const declaration = declarePaymentIdentifierExtension();
      expect(declaration.info).toEqual({ required: false });
    });

    it("should return a declaration with required=true when specified", () => {
      const declaration = declarePaymentIdentifierExtension(true);
      expect(declaration.info).toEqual({ required: true });
    });

    it("should include the schema", () => {
      const declaration = declarePaymentIdentifierExtension();
      expect(declaration.schema).toBeDefined();
      expect(declaration.schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(declaration.schema.properties.required.type).toBe("boolean");
      expect(declaration.schema.properties.id.minLength).toBe(16);
      expect(declaration.schema.properties.id.maxLength).toBe(128);
    });
  });

  describe("validatePaymentIdentifier", () => {
    it("should validate a correct extension", () => {
      const extension = createExtensionWithId();
      const result = validatePaymentIdentifier(extension);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it("should reject non-object extension", () => {
      expect(validatePaymentIdentifier(null).valid).toBe(false);
      expect(validatePaymentIdentifier(undefined).valid).toBe(false);
      expect(validatePaymentIdentifier("string").valid).toBe(false);
    });

    it("should reject extension without info", () => {
      const result = validatePaymentIdentifier({ schema: paymentIdentifierSchema });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Extension must have an 'info' property");
    });

    it("should reject extension without required in info", () => {
      const result = validatePaymentIdentifier({
        info: { id: "pay_valid_id_12345678" },
        schema: paymentIdentifierSchema,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Extension info must have a 'required' boolean property");
    });

    it("should validate extension with required but no id", () => {
      const result = validatePaymentIdentifier({
        info: { required: false },
        schema: paymentIdentifierSchema,
      });
      expect(result.valid).toBe(true);
    });

    it("should reject extension with invalid id format", () => {
      const result = validatePaymentIdentifier({
        info: { required: false, id: "short" },
        schema: paymentIdentifierSchema,
      });
      expect(result.valid).toBe(false);
    });

    it("should reject extension with non-string id", () => {
      const result = validatePaymentIdentifier({
        info: { required: false, id: 123 as unknown as string },
        schema: paymentIdentifierSchema,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Extension info 'id' must be a string if provided");
    });

    it("should validate extension with valid schema", () => {
      const result = validatePaymentIdentifier({
        info: { required: false, id: "valid_id_12345678" },
        schema: paymentIdentifierSchema,
      });
      expect(result.valid).toBe(true);
    });

    it("should reject extension that fails schema validation", () => {
      const invalidSchema = {
        ...paymentIdentifierSchema,
        properties: {
          ...paymentIdentifierSchema.properties,
          required: { type: "string" }, // Wrong type
        },
      };
      const result = validatePaymentIdentifier({
        info: { required: false },
        schema: invalidSchema,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });
  });

  describe("extractPaymentIdentifier", () => {
    const createMockPayload = (extensions?: Record<string, unknown>): PaymentPayload => ({
      x402Version: 2,
      resource: { url: "https://example.com/resource", method: "GET" },
      accepted: {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x...",
        amount: "1000000",
        payTo: "0x...",
        maxTimeoutSeconds: 300,
        extra: {},
      },
      payload: {},
      extensions,
    });

    it("should extract ID from valid payload", () => {
      const extension = createExtensionWithId("pay_test_id_12345678");
      const payload = createMockPayload({ [PAYMENT_IDENTIFIER]: extension });
      const id = extractPaymentIdentifier(payload);
      expect(id).toBe("pay_test_id_12345678");
    });

    it("should return null when no extensions", () => {
      const payload = createMockPayload();
      const id = extractPaymentIdentifier(payload);
      expect(id).toBeNull();
    });

    it("should return null when payment-identifier extension is missing", () => {
      const payload = createMockPayload({ other: {} });
      const id = extractPaymentIdentifier(payload);
      expect(id).toBeNull();
    });

    it("should return null for invalid ID when validate=true", () => {
      const payload = createMockPayload({
        [PAYMENT_IDENTIFIER]: { info: { required: false, id: "short" } },
      });
      const id = extractPaymentIdentifier(payload, true);
      expect(id).toBeNull();
    });

    it("should return ID for invalid format when validate=false", () => {
      const payload = createMockPayload({
        [PAYMENT_IDENTIFIER]: { info: { required: false, id: "short" } },
      });
      const id = extractPaymentIdentifier(payload, false);
      expect(id).toBe("short");
    });

    it("should return null when extension has no id", () => {
      const payload = createMockPayload({
        [PAYMENT_IDENTIFIER]: { info: { required: false } },
      });
      const id = extractPaymentIdentifier(payload);
      expect(id).toBeNull();
    });

    it("should return null when extensions is null", () => {
      const payload = createMockPayload();
      payload.extensions = null as unknown as Record<string, unknown>;
      const id = extractPaymentIdentifier(payload);
      expect(id).toBeNull();
    });

    it("should return null when extension exists but is null", () => {
      const payload = createMockPayload({
        [PAYMENT_IDENTIFIER]: null,
      });
      const id = extractPaymentIdentifier(payload);
      expect(id).toBeNull();
    });

    it("should return null when extension exists but info is null", () => {
      const payload = createMockPayload({
        [PAYMENT_IDENTIFIER]: { info: null },
      });
      const id = extractPaymentIdentifier(payload);
      expect(id).toBeNull();
    });

    it("should return null when id exists but is not a string", () => {
      const payload = createMockPayload({
        [PAYMENT_IDENTIFIER]: { info: { required: false, id: 123 } },
      });
      const id = extractPaymentIdentifier(payload);
      expect(id).toBeNull();
    });

    it("should return null when id exists but is undefined", () => {
      const payload = createMockPayload({
        [PAYMENT_IDENTIFIER]: { info: { required: false, id: undefined } },
      });
      const id = extractPaymentIdentifier(payload);
      expect(id).toBeNull();
    });
  });

  describe("extractAndValidatePaymentIdentifier", () => {
    const createMockPayload = (extensions?: Record<string, unknown>): PaymentPayload => ({
      x402Version: 2,
      resource: { url: "https://example.com/resource", method: "GET" },
      accepted: {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x...",
        amount: "1000000",
        payTo: "0x...",
        maxTimeoutSeconds: 300,
        extra: {},
      },
      payload: {},
      extensions,
    });

    it("should extract and validate a valid extension", () => {
      const extension = createExtensionWithId("pay_test_id_12345678");
      const payload = createMockPayload({ [PAYMENT_IDENTIFIER]: extension });
      const { id, validation } = extractAndValidatePaymentIdentifier(payload);
      expect(id).toBe("pay_test_id_12345678");
      expect(validation.valid).toBe(true);
    });

    it("should return null id and valid=true when no extensions", () => {
      const payload = createMockPayload();
      const { id, validation } = extractAndValidatePaymentIdentifier(payload);
      expect(id).toBeNull();
      expect(validation.valid).toBe(true);
    });

    it("should return validation errors for invalid extension", () => {
      const payload = createMockPayload({
        [PAYMENT_IDENTIFIER]: { info: { id: "short" } },
      });
      const { id, validation } = extractAndValidatePaymentIdentifier(payload);
      expect(id).toBeNull();
      expect(validation.valid).toBe(false);
      expect(validation.errors).toBeDefined();
    });

    it("should return null id but valid=true when no id provided", () => {
      const payload = createMockPayload({
        [PAYMENT_IDENTIFIER]: { info: { required: false }, schema: paymentIdentifierSchema },
      });
      const { id, validation } = extractAndValidatePaymentIdentifier(payload);
      expect(id).toBeNull();
      expect(validation.valid).toBe(true);
    });

    it("should return validation errors when extension structure is invalid", () => {
      const payload = createMockPayload({
        [PAYMENT_IDENTIFIER]: { info: { id: "short" } }, // Missing required
      });
      const { id, validation } = extractAndValidatePaymentIdentifier(payload);
      expect(id).toBeNull();
      expect(validation.valid).toBe(false);
      expect(validation.errors).toBeDefined();
    });

    it("should return null id when extension exists but is null", () => {
      const payload = createMockPayload({
        [PAYMENT_IDENTIFIER]: null,
      });
      const { id, validation } = extractAndValidatePaymentIdentifier(payload);
      expect(id).toBeNull();
      expect(validation.valid).toBe(true);
    });
  });

  describe("hasPaymentIdentifier", () => {
    const createMockPayload = (extensions?: Record<string, unknown>): PaymentPayload => ({
      x402Version: 2,
      resource: { url: "https://example.com/resource", method: "GET" },
      accepted: {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x...",
        amount: "1000000",
        payTo: "0x...",
        maxTimeoutSeconds: 300,
        extra: {},
      },
      payload: {},
      extensions,
    });

    it("should return true when extension is present", () => {
      const extension = createExtensionWithId();
      const payload = createMockPayload({ [PAYMENT_IDENTIFIER]: extension });
      expect(hasPaymentIdentifier(payload)).toBe(true);
    });

    it("should return false when no extensions", () => {
      const payload = createMockPayload();
      expect(hasPaymentIdentifier(payload)).toBe(false);
    });

    it("should return false when different extension present", () => {
      const payload = createMockPayload({ bazaar: {} });
      expect(hasPaymentIdentifier(payload)).toBe(false);
    });
  });

  describe("isPaymentIdentifierExtension", () => {
    it("should return true for valid extension with id", () => {
      const extension = createExtensionWithId("pay_test_id_12345678");
      expect(isPaymentIdentifierExtension(extension)).toBe(true);
    });

    it("should return true for valid declaration without id", () => {
      const declaration = declarePaymentIdentifierExtension();
      expect(isPaymentIdentifierExtension(declaration)).toBe(true);
    });

    it("should return true for declaration with required=true", () => {
      const declaration = declarePaymentIdentifierExtension(true);
      expect(isPaymentIdentifierExtension(declaration)).toBe(true);
    });

    it("should return false for null/undefined", () => {
      expect(isPaymentIdentifierExtension(null)).toBe(false);
      expect(isPaymentIdentifierExtension(undefined)).toBe(false);
    });

    it("should return false for non-object", () => {
      expect(isPaymentIdentifierExtension("string")).toBe(false);
      expect(isPaymentIdentifierExtension(123)).toBe(false);
    });

    it("should return false for object without info", () => {
      expect(isPaymentIdentifierExtension({})).toBe(false);
      expect(isPaymentIdentifierExtension({ schema: paymentIdentifierSchema })).toBe(false);
    });

    it("should return false for object with invalid info", () => {
      expect(isPaymentIdentifierExtension({ info: null })).toBe(false);
      expect(isPaymentIdentifierExtension({ info: "string" })).toBe(false);
    });

    it("should return false for info without required boolean", () => {
      expect(isPaymentIdentifierExtension({ info: {} })).toBe(false);
      expect(isPaymentIdentifierExtension({ info: { id: "pay_test_id_12345678" } })).toBe(false);
      expect(isPaymentIdentifierExtension({ info: { required: "false" } })).toBe(false);
    });
  });

  describe("isPaymentIdentifierRequired", () => {
    it("should return true when required is true", () => {
      const extension = { info: { required: true } };
      expect(isPaymentIdentifierRequired(extension)).toBe(true);
    });

    it("should return false when required is false", () => {
      const extension = { info: { required: false } };
      expect(isPaymentIdentifierRequired(extension)).toBe(false);
    });

    it("should return false for invalid extension", () => {
      expect(isPaymentIdentifierRequired(null)).toBe(false);
      expect(isPaymentIdentifierRequired(undefined)).toBe(false);
      expect(isPaymentIdentifierRequired({})).toBe(false);
      expect(isPaymentIdentifierRequired({ info: {} })).toBe(false);
    });
  });

  describe("validatePaymentIdentifierRequirement", () => {
    const createMockPayload = (extensions?: Record<string, unknown>): PaymentPayload => ({
      x402Version: 2,
      resource: { url: "https://example.com/resource", method: "GET" },
      accepted: {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x...",
        amount: "1000000",
        payTo: "0x...",
        maxTimeoutSeconds: 300,
        extra: {},
      },
      payload: {},
      extensions,
    });

    it("should pass when required=false and no id provided", () => {
      const payload = createMockPayload();
      const result = validatePaymentIdentifierRequirement(payload, false);
      expect(result.valid).toBe(true);
    });

    it("should pass when required=true and valid id provided", () => {
      const extension = createExtensionWithId("pay_test_id_12345678", true);
      const payload = createMockPayload({ [PAYMENT_IDENTIFIER]: extension });
      const result = validatePaymentIdentifierRequirement(payload, true);
      expect(result.valid).toBe(true);
    });

    it("should fail when required=true and no id provided", () => {
      const payload = createMockPayload();
      const result = validatePaymentIdentifierRequirement(payload, true);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Server requires a payment identifier but none was provided");
    });

    it("should fail when required=true and invalid id provided", () => {
      const payload = createMockPayload({
        [PAYMENT_IDENTIFIER]: { info: { required: true, id: "short" } },
      });
      const result = validatePaymentIdentifierRequirement(payload, true);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it("should pass when required=false even if invalid id provided", () => {
      const payload = createMockPayload({
        [PAYMENT_IDENTIFIER]: { info: { required: false, id: "short" } },
      });
      const result = validatePaymentIdentifierRequirement(payload, false);
      expect(result.valid).toBe(true);
    });

    it("should pass when required=true and valid id provided", () => {
      const extension = createExtensionWithId("valid_id_12345678", true);
      const payload = createMockPayload({ [PAYMENT_IDENTIFIER]: extension });
      const result = validatePaymentIdentifierRequirement(payload, true);
      expect(result.valid).toBe(true);
    });
  });

  describe("paymentIdentifierSchema", () => {
    it("should have correct JSON Schema draft", () => {
      expect(paymentIdentifierSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    });

    it("should require the required property", () => {
      expect(paymentIdentifierSchema.required).toContain("required");
    });

    it("should have correct required property definition", () => {
      expect(paymentIdentifierSchema.properties.required.type).toBe("boolean");
    });

    it("should have correct id constraints", () => {
      expect(paymentIdentifierSchema.properties.id.type).toBe("string");
      expect(paymentIdentifierSchema.properties.id.minLength).toBe(16);
      expect(paymentIdentifierSchema.properties.id.maxLength).toBe(128);
      expect(paymentIdentifierSchema.properties.id.pattern).toBe("^[a-zA-Z0-9_-]+$");
    });
  });

  describe("paymentIdentifierResourceServerExtension", () => {
    it("should have correct key", () => {
      expect(paymentIdentifierResourceServerExtension.key).toBe(PAYMENT_IDENTIFIER);
    });

    it("should be a valid ResourceServerExtension", () => {
      expect(paymentIdentifierResourceServerExtension).toBeDefined();
      expect(typeof paymentIdentifierResourceServerExtension.key).toBe("string");
    });
  });
});
