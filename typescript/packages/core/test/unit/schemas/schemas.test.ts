import { describe, it, expect } from "vitest";
import {
  // V1 schemas
  PaymentRequirementsV1Schema,
  PaymentRequiredV1Schema,
  PaymentPayloadV1Schema,
  isPaymentRequirementsV1,
  isPaymentRequiredV1,
  isPaymentPayloadV1,
  // V2 schemas
  PaymentRequirementsV2Schema,
  PaymentRequiredV2Schema,
  PaymentPayloadV2Schema,
  isPaymentRequirementsV2,
  isPaymentRequiredV2,
  isPaymentPayloadV2,
  // Union schemas
  PaymentRequirementsSchema,
  PaymentRequiredSchema,
  PaymentPayloadSchema,
  isPaymentRequirements,
  isPaymentRequired,
  isPaymentPayload,
  // Validation functions
  parsePaymentRequired,
  parsePaymentRequirements,
  parsePaymentPayload,
  validatePaymentRequired,
  validatePaymentRequirements,
  validatePaymentPayload,
} from "../../../src/schemas";

describe("x402 Schemas", () => {
  // ============================================================================
  // V1 Test Data
  // ============================================================================
  const validPaymentRequirementsV1 = {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "10000",
    resource: "https://api.example.com/premium-data",
    description: "Access to premium market data",
    mimeType: "application/json",
    outputSchema: null,
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    maxTimeoutSeconds: 60,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    extra: { name: "USDC", version: "2" },
  };

  const validPaymentRequiredV1 = {
    x402Version: 1 as const,
    error: "Payment required",
    accepts: [validPaymentRequirementsV1],
  };

  const validPaymentPayloadV1 = {
    x402Version: 1 as const,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0x1234",
      authorization: { from: "0xabc", to: "0xdef" },
    },
  };

  // ============================================================================
  // V2 Test Data
  // ============================================================================
  const validPaymentRequirementsV2 = {
    scheme: "exact",
    network: "eip155:84532",
    amount: "10000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  };

  const validPaymentRequiredV2 = {
    x402Version: 2 as const,
    error: "Payment required",
    resource: {
      url: "https://api.example.com/premium-data",
      description: "Access to premium market data",
      mimeType: "application/json",
    },
    accepts: [validPaymentRequirementsV2],
    extensions: {},
  };

  const validPaymentPayloadV2 = {
    x402Version: 2 as const,
    resource: {
      url: "https://api.example.com/premium-data",
      description: "Access to premium market data",
    },
    accepted: validPaymentRequirementsV2,
    payload: {
      signature: "0x1234",
      authorization: { from: "0xabc", to: "0xdef" },
    },
    extensions: {},
  };

  // ============================================================================
  // V1 Schema Tests
  // ============================================================================
  describe("V1 Schemas", () => {
    describe("PaymentRequirementsV1Schema", () => {
      it("should validate valid PaymentRequirementsV1", () => {
        const result = PaymentRequirementsV1Schema.safeParse(validPaymentRequirementsV1);
        expect(result.success).toBe(true);
      });

      it("should reject missing required fields", () => {
        const invalid = { ...validPaymentRequirementsV1 };
        delete (invalid as Record<string, unknown>).scheme;
        const result = PaymentRequirementsV1Schema.safeParse(invalid);
        expect(result.success).toBe(false);
      });

      it("should reject empty scheme", () => {
        const invalid = { ...validPaymentRequirementsV1, scheme: "" };
        const result = PaymentRequirementsV1Schema.safeParse(invalid);
        expect(result.success).toBe(false);
      });

      it("should reject non-positive maxTimeoutSeconds", () => {
        const invalid = { ...validPaymentRequirementsV1, maxTimeoutSeconds: 0 };
        const result = PaymentRequirementsV1Schema.safeParse(invalid);
        expect(result.success).toBe(false);
      });
    });

    describe("PaymentRequiredV1Schema", () => {
      it("should validate valid PaymentRequiredV1", () => {
        const result = PaymentRequiredV1Schema.safeParse(validPaymentRequiredV1);
        expect(result.success).toBe(true);
      });

      it("should reject wrong x402Version", () => {
        const invalid = { ...validPaymentRequiredV1, x402Version: 2 };
        const result = PaymentRequiredV1Schema.safeParse(invalid);
        expect(result.success).toBe(false);
      });

      it("should reject empty accepts array", () => {
        const invalid = { ...validPaymentRequiredV1, accepts: [] };
        const result = PaymentRequiredV1Schema.safeParse(invalid);
        expect(result.success).toBe(false);
      });
    });

    describe("PaymentPayloadV1Schema", () => {
      it("should validate valid PaymentPayloadV1", () => {
        const result = PaymentPayloadV1Schema.safeParse(validPaymentPayloadV1);
        expect(result.success).toBe(true);
      });

      it("should reject wrong x402Version", () => {
        const invalid = { ...validPaymentPayloadV1, x402Version: 2 };
        const result = PaymentPayloadV1Schema.safeParse(invalid);
        expect(result.success).toBe(false);
      });
    });

    describe("V1 Type Guards", () => {
      it("isPaymentRequirementsV1 should return true for valid V1 requirements", () => {
        expect(isPaymentRequirementsV1(validPaymentRequirementsV1)).toBe(true);
      });

      it("isPaymentRequirementsV1 should return false for V2 requirements", () => {
        expect(isPaymentRequirementsV1(validPaymentRequirementsV2)).toBe(false);
      });

      it("isPaymentRequiredV1 should return true for valid V1", () => {
        expect(isPaymentRequiredV1(validPaymentRequiredV1)).toBe(true);
      });

      it("isPaymentRequiredV1 should return false for V2", () => {
        expect(isPaymentRequiredV1(validPaymentRequiredV2)).toBe(false);
      });

      it("isPaymentPayloadV1 should return true for valid V1", () => {
        expect(isPaymentPayloadV1(validPaymentPayloadV1)).toBe(true);
      });

      it("isPaymentPayloadV1 should return false for V2", () => {
        expect(isPaymentPayloadV1(validPaymentPayloadV2)).toBe(false);
      });
    });
  });

  // ============================================================================
  // V2 Schema Tests
  // ============================================================================
  describe("V2 Schemas", () => {
    describe("PaymentRequirementsV2Schema", () => {
      it("should validate valid PaymentRequirementsV2", () => {
        const result = PaymentRequirementsV2Schema.safeParse(validPaymentRequirementsV2);
        expect(result.success).toBe(true);
      });

      it("should reject missing required fields", () => {
        const invalid = { ...validPaymentRequirementsV2 };
        delete (invalid as Record<string, unknown>).amount;
        const result = PaymentRequirementsV2Schema.safeParse(invalid);
        expect(result.success).toBe(false);
      });

      it("should allow missing optional extra field", () => {
        const withoutExtra = { ...validPaymentRequirementsV2 };
        delete (withoutExtra as Record<string, unknown>).extra;
        const result = PaymentRequirementsV2Schema.safeParse(withoutExtra);
        expect(result.success).toBe(true);
      });
    });

    describe("PaymentRequiredV2Schema", () => {
      it("should validate valid PaymentRequiredV2", () => {
        const result = PaymentRequiredV2Schema.safeParse(validPaymentRequiredV2);
        expect(result.success).toBe(true);
      });

      it("should reject wrong x402Version", () => {
        const invalid = { ...validPaymentRequiredV2, x402Version: 1 };
        const result = PaymentRequiredV2Schema.safeParse(invalid);
        expect(result.success).toBe(false);
      });

      it("should reject missing resource", () => {
        const invalid = { ...validPaymentRequiredV2 };
        delete (invalid as Record<string, unknown>).resource;
        const result = PaymentRequiredV2Schema.safeParse(invalid);
        expect(result.success).toBe(false);
      });

      it("should reject resource without url", () => {
        const invalid = {
          ...validPaymentRequiredV2,
          resource: { description: "test" },
        };
        const result = PaymentRequiredV2Schema.safeParse(invalid);
        expect(result.success).toBe(false);
      });
    });

    describe("PaymentPayloadV2Schema", () => {
      it("should validate valid PaymentPayloadV2", () => {
        const result = PaymentPayloadV2Schema.safeParse(validPaymentPayloadV2);
        expect(result.success).toBe(true);
      });

      it("should reject wrong x402Version", () => {
        const invalid = { ...validPaymentPayloadV2, x402Version: 1 };
        const result = PaymentPayloadV2Schema.safeParse(invalid);
        expect(result.success).toBe(false);
      });

      it("should allow optional resource", () => {
        const withoutResource = { ...validPaymentPayloadV2 };
        delete (withoutResource as Record<string, unknown>).resource;
        const result = PaymentPayloadV2Schema.safeParse(withoutResource);
        expect(result.success).toBe(true);
      });
    });

    describe("V2 Type Guards", () => {
      it("isPaymentRequirementsV2 should return true for valid V2 requirements", () => {
        expect(isPaymentRequirementsV2(validPaymentRequirementsV2)).toBe(true);
      });

      it("isPaymentRequirementsV2 should return false for V1 requirements", () => {
        expect(isPaymentRequirementsV2(validPaymentRequirementsV1)).toBe(false);
      });

      it("isPaymentRequiredV2 should return true for valid V2", () => {
        expect(isPaymentRequiredV2(validPaymentRequiredV2)).toBe(true);
      });

      it("isPaymentRequiredV2 should return false for V1", () => {
        expect(isPaymentRequiredV2(validPaymentRequiredV1)).toBe(false);
      });

      it("isPaymentPayloadV2 should return true for valid V2", () => {
        expect(isPaymentPayloadV2(validPaymentPayloadV2)).toBe(true);
      });

      it("isPaymentPayloadV2 should return false for V1", () => {
        expect(isPaymentPayloadV2(validPaymentPayloadV1)).toBe(false);
      });
    });
  });

  // ============================================================================
  // Union Schema Tests
  // ============================================================================
  describe("Union Schemas", () => {
    describe("PaymentRequirementsSchema", () => {
      it("should accept V1 requirements", () => {
        const result = PaymentRequirementsSchema.safeParse(validPaymentRequirementsV1);
        expect(result.success).toBe(true);
      });

      it("should accept V2 requirements", () => {
        const result = PaymentRequirementsSchema.safeParse(validPaymentRequirementsV2);
        expect(result.success).toBe(true);
      });

      it("should reject invalid requirements", () => {
        const result = PaymentRequirementsSchema.safeParse({ invalid: true });
        expect(result.success).toBe(false);
      });
    });

    describe("PaymentRequiredSchema (discriminated union)", () => {
      it("should accept V1 PaymentRequired", () => {
        const result = PaymentRequiredSchema.safeParse(validPaymentRequiredV1);
        expect(result.success).toBe(true);
      });

      it("should accept V2 PaymentRequired", () => {
        const result = PaymentRequiredSchema.safeParse(validPaymentRequiredV2);
        expect(result.success).toBe(true);
      });

      it("should reject invalid x402Version", () => {
        const invalid = { ...validPaymentRequiredV1, x402Version: 3 };
        const result = PaymentRequiredSchema.safeParse(invalid);
        expect(result.success).toBe(false);
      });
    });

    describe("PaymentPayloadSchema (discriminated union)", () => {
      it("should accept V1 PaymentPayload", () => {
        const result = PaymentPayloadSchema.safeParse(validPaymentPayloadV1);
        expect(result.success).toBe(true);
      });

      it("should accept V2 PaymentPayload", () => {
        const result = PaymentPayloadSchema.safeParse(validPaymentPayloadV2);
        expect(result.success).toBe(true);
      });

      it("should reject invalid x402Version", () => {
        const invalid = { ...validPaymentPayloadV1, x402Version: 3 };
        const result = PaymentPayloadSchema.safeParse(invalid);
        expect(result.success).toBe(false);
      });
    });

    describe("Union Type Guards", () => {
      it("isPaymentRequired should return true for V1", () => {
        expect(isPaymentRequired(validPaymentRequiredV1)).toBe(true);
      });

      it("isPaymentRequired should return true for V2", () => {
        expect(isPaymentRequired(validPaymentRequiredV2)).toBe(true);
      });

      it("isPaymentRequired should return false for invalid", () => {
        expect(isPaymentRequired({ invalid: true })).toBe(false);
      });

      it("isPaymentRequirements should return true for V1", () => {
        expect(isPaymentRequirements(validPaymentRequirementsV1)).toBe(true);
      });

      it("isPaymentRequirements should return true for V2", () => {
        expect(isPaymentRequirements(validPaymentRequirementsV2)).toBe(true);
      });

      it("isPaymentPayload should return true for V1", () => {
        expect(isPaymentPayload(validPaymentPayloadV1)).toBe(true);
      });

      it("isPaymentPayload should return true for V2", () => {
        expect(isPaymentPayload(validPaymentPayloadV2)).toBe(true);
      });
    });
  });

  // ============================================================================
  // Validation Function Tests
  // ============================================================================
  describe("Validation Functions", () => {
    describe("parsePaymentRequired", () => {
      it("should return success for valid V1", () => {
        const result = parsePaymentRequired(validPaymentRequiredV1);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.x402Version).toBe(1);
        }
      });

      it("should return success for valid V2", () => {
        const result = parsePaymentRequired(validPaymentRequiredV2);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.x402Version).toBe(2);
        }
      });

      it("should return error for invalid data", () => {
        const result = parsePaymentRequired({ invalid: true });
        expect(result.success).toBe(false);
      });
    });

    describe("validatePaymentRequired", () => {
      it("should return validated data for valid input", () => {
        const result = validatePaymentRequired(validPaymentRequiredV2);
        expect(result.x402Version).toBe(2);
      });

      it("should throw for invalid input", () => {
        expect(() => validatePaymentRequired({ invalid: true })).toThrow();
      });
    });

    describe("parsePaymentRequirements", () => {
      it("should return success for valid V1", () => {
        const result = parsePaymentRequirements(validPaymentRequirementsV1);
        expect(result.success).toBe(true);
      });

      it("should return success for valid V2", () => {
        const result = parsePaymentRequirements(validPaymentRequirementsV2);
        expect(result.success).toBe(true);
      });
    });

    describe("validatePaymentRequirements", () => {
      it("should return validated data for valid input", () => {
        const result = validatePaymentRequirements(validPaymentRequirementsV2);
        expect(result.scheme).toBe("exact");
      });

      it("should throw for invalid input", () => {
        expect(() => validatePaymentRequirements({ invalid: true })).toThrow();
      });
    });

    describe("parsePaymentPayload", () => {
      it("should return success for valid V1", () => {
        const result = parsePaymentPayload(validPaymentPayloadV1);
        expect(result.success).toBe(true);
      });

      it("should return success for valid V2", () => {
        const result = parsePaymentPayload(validPaymentPayloadV2);
        expect(result.success).toBe(true);
      });
    });

    describe("validatePaymentPayload", () => {
      it("should return validated data for valid input", () => {
        const result = validatePaymentPayload(validPaymentPayloadV2);
        expect(result.x402Version).toBe(2);
      });

      it("should throw for invalid input", () => {
        expect(() => validatePaymentPayload({ invalid: true })).toThrow();
      });
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================
  describe("Edge Cases", () => {
    it("should handle null values gracefully", () => {
      expect(isPaymentRequired(null)).toBe(false);
      expect(isPaymentRequirements(null)).toBe(false);
      expect(isPaymentPayload(null)).toBe(false);
    });

    it("should handle undefined values gracefully", () => {
      expect(isPaymentRequired(undefined)).toBe(false);
      expect(isPaymentRequirements(undefined)).toBe(false);
      expect(isPaymentPayload(undefined)).toBe(false);
    });

    it("should handle non-object values gracefully", () => {
      expect(isPaymentRequired("string")).toBe(false);
      expect(isPaymentRequired(123)).toBe(false);
      expect(isPaymentRequired([])).toBe(false);
    });

    it("should allow extra unknown fields (loose validation)", () => {
      const withExtra = {
        ...validPaymentRequirementsV2,
        unknownField: "should be ignored",
        anotherUnknown: { nested: true },
      };
      const result = PaymentRequirementsV2Schema.safeParse(withExtra);
      expect(result.success).toBe(true);
    });

    it("should validate V1 outputSchema can be null", () => {
      const withNullSchema = {
        ...validPaymentRequirementsV1,
        outputSchema: null,
      };
      const result = PaymentRequirementsV1Schema.safeParse(withNullSchema);
      expect(result.success).toBe(true);
    });

    it("should validate V1 outputSchema can be an object", () => {
      const withSchema = {
        ...validPaymentRequirementsV1,
        outputSchema: { type: "object", properties: {} },
      };
      const result = PaymentRequirementsV1Schema.safeParse(withSchema);
      expect(result.success).toBe(true);
    });
  });

  // ============================================================================
  // Network Schema Tests
  // ============================================================================
  describe("Network Schema Validation", () => {
    describe("V1 Network (loose)", () => {
      it("should accept any non-empty string for V1", () => {
        const v1WithSimpleNetwork = {
          ...validPaymentRequirementsV1,
          network: "base-sepolia",
        };
        const result = PaymentRequirementsV1Schema.safeParse(v1WithSimpleNetwork);
        expect(result.success).toBe(true);
      });

      it("should accept CAIP-2 format for V1", () => {
        const v1WithCaip2 = {
          ...validPaymentRequirementsV1,
          network: "eip155:84532",
        };
        const result = PaymentRequirementsV1Schema.safeParse(v1WithCaip2);
        expect(result.success).toBe(true);
      });

      it("should reject empty string for V1", () => {
        const v1WithEmpty = {
          ...validPaymentRequirementsV1,
          network: "",
        };
        const result = PaymentRequirementsV1Schema.safeParse(v1WithEmpty);
        expect(result.success).toBe(false);
      });
    });

    describe("V2 Network (CAIP-2 required)", () => {
      it("should accept valid CAIP-2 format for V2", () => {
        const v2Valid = {
          ...validPaymentRequirementsV2,
          network: "eip155:84532",
        };
        const result = PaymentRequirementsV2Schema.safeParse(v2Valid);
        expect(result.success).toBe(true);
      });

      it("should accept Solana CAIP-2 format for V2", () => {
        const v2Solana = {
          ...validPaymentRequirementsV2,
          network: "solana:devnet",
        };
        const result = PaymentRequirementsV2Schema.safeParse(v2Solana);
        expect(result.success).toBe(true);
      });

      it("should reject V1-style network names for V2", () => {
        const v2WithV1Style = {
          ...validPaymentRequirementsV2,
          network: "base-sepolia",
        };
        const result = PaymentRequirementsV2Schema.safeParse(v2WithV1Style);
        expect(result.success).toBe(false);
      });

      it("should reject network without colon for V2", () => {
        const v2NoColon = {
          ...validPaymentRequirementsV2,
          network: "ethereum",
        };
        const result = PaymentRequirementsV2Schema.safeParse(v2NoColon);
        expect(result.success).toBe(false);
      });

      it("should reject network too short for V2", () => {
        const v2TooShort = {
          ...validPaymentRequirementsV2,
          network: "a:",
        };
        const result = PaymentRequirementsV2Schema.safeParse(v2TooShort);
        expect(result.success).toBe(false);
      });

      it("should accept minimum valid CAIP-2 for V2", () => {
        const v2Minimal = {
          ...validPaymentRequirementsV2,
          network: "a:b",
        };
        const result = PaymentRequirementsV2Schema.safeParse(v2Minimal);
        expect(result.success).toBe(true);
      });
    });
  });
});
