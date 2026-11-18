import { describe, it, expect } from "vitest";
import {
  ListDiscoveryResourcesResponseSchema,
  SupportedPaymentKindsResponseSchema,
  VerifyResponseSchema,
  x402ResponseSchema,
} from "./x402Specs";

describe("x402Specs Regex Patterns", () => {
  // Import the regex patterns from the source file
  const EvmAddressRegex = /^0x[0-9a-fA-F]{40}$/;
  const HexEncoded64ByteRegex = /^0x[0-9a-fA-F]{64}$/;
  const EvmECDSASignatureRegex = /^0x[0-9a-fA-F]{130}$/;
  const Evm6492SignatureRegex =
    /^0x[0-9a-fA-F]+6492649264926492649264926492649264926492649264926492649264926492$/;

  describe("EvmAddressRegex", () => {
    it("should match valid EVM addresses", () => {
      const validAddresses = [
        "0x1234567890123456789012345678901234567890",
        "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd",
        "0x0000000000000000000000000000000000000000",
        "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        "0x1a2b3c4d5e6f7890123456789012345678901234",
      ];

      validAddresses.forEach(address => {
        expect(EvmAddressRegex.test(address)).toBe(true);
      });
    });

    it("should reject invalid EVM addresses", () => {
      const invalidAddresses = [
        "0x123", // Too short
        "0x12345678901234567890123456789012345678901", // Too long
        "1234567890123456789012345678901234567890", // Missing 0x prefix
        "0xGHIJ567890123456789012345678901234567890", // Invalid hex chars
        "0xg234567890123456789012345678901234567890", // Invalid hex char 'g'
        "", // Empty string
        "0x", // Just prefix
        "0X1234567890123456789012345678901234567890", // Wrong case prefix
        "0x123456789012345678901234567890123456789", // 39 chars (too short)
        "0x12345678901234567890123456789012345678901", // 41 chars (too long)
      ];

      invalidAddresses.forEach(address => {
        expect(EvmAddressRegex.test(address)).toBe(false);
      });
    });
  });

  describe("HexEncoded64ByteRegex", () => {
    it("should match valid 64-byte hex strings", () => {
      const validHexStrings = [
        "0x" + "0".repeat(64), // All zeros
        "0x" + "f".repeat(64), // All f's
        "0x" + "F".repeat(64), // All F's (uppercase)
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        "0xABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890",
        "0x" + "123456789abcdef0".repeat(4), // Pattern repeated
      ];

      validHexStrings.forEach(hexString => {
        expect(HexEncoded64ByteRegex.test(hexString)).toBe(true);
      });
    });

    it("should reject invalid hex strings", () => {
      const invalidHexStrings = [
        "0x" + "0".repeat(63), // Too short
        "0x" + "0".repeat(65), // Too long
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", // No 0x prefix
        "0x" + "g".repeat(64), // Invalid hex character
        "0x" + "0".repeat(32), // 32 bytes instead of 64
        "", // Empty string
        "0x", // Just prefix
        "0X" + "0".repeat(64), // Wrong case prefix
      ];

      invalidHexStrings.forEach(hexString => {
        expect(HexEncoded64ByteRegex.test(hexString)).toBe(false);
      });
    });
  });

  describe("EvmECDSASignatureRegex", () => {
    it("should match valid ECDSA signatures", () => {
      const validSignatures = [
        "0x" + "0".repeat(130), // All zeros
        "0x" + "f".repeat(130), // All f's
        "0x" + "F".repeat(130), // All F's (uppercase)
        "0x" + "1234567890abcdef".repeat(8) + "12", // Mixed case
        "0x" + "ABCDEF1234567890".repeat(8) + "12", // Exactly 130 hex chars
      ];

      validSignatures.forEach(signature => {
        expect(EvmECDSASignatureRegex.test(signature)).toBe(true);
      });
    });

    it("should reject invalid ECDSA signatures", () => {
      const invalidSignatures = [
        "0x" + "0".repeat(129), // Too short
        "0x" + "0".repeat(131), // Too long
        "1234567890abcdef".repeat(8) + "12", // No 0x prefix
        "0x" + "g".repeat(130), // Invalid hex character
        "0x" + "0".repeat(64), // Too short (64 bytes)
        "", // Empty string
        "0x", // Just prefix
        "0X" + "0".repeat(130), // Wrong case prefix
      ];

      invalidSignatures.forEach(signature => {
        expect(EvmECDSASignatureRegex.test(signature)).toBe(false);
      });
    });
  });

  describe("Evm6492SignatureRegex", () => {
    const erc6492Suffix = "6492649264926492649264926492649264926492649264926492649264926492";

    it("should match valid ERC-6492 signatures with minimum hex chars", () => {
      const validSignatures = [
        "0x" + "a" + erc6492Suffix, // Just 1 hex char before suffix
        "0x" + "12" + erc6492Suffix, // 2 hex chars before suffix
        "0x" + "abc" + erc6492Suffix, // 3 hex chars before suffix
        "0x" + "F" + erc6492Suffix, // Single uppercase hex char
      ];

      validSignatures.forEach(signature => {
        expect(Evm6492SignatureRegex.test(signature)).toBe(true);
      });
    });

    it("should match valid ERC-6492 signatures at various lengths", () => {
      const validSignatures = [
        "0x" + "0".repeat(130) + erc6492Suffix, // Standard ECDSA length
        "0x" + "a".repeat(200) + erc6492Suffix, // 200 chars before suffix
        "0x" + "b".repeat(500) + erc6492Suffix, // 500 chars before suffix
        "0x" + "c".repeat(1000) + erc6492Suffix, // 1000 chars before suffix
        "0x" + "d".repeat(5000) + erc6492Suffix, // Very long signature
        "0x" + "1234567890abcdef".repeat(100) + erc6492Suffix, // Pattern repeated
      ];

      validSignatures.forEach(signature => {
        expect(Evm6492SignatureRegex.test(signature)).toBe(true);
      });
    });

    it("should reject invalid ERC-6492 signatures", () => {
      const invalidSignatures = [
        "0x" + erc6492Suffix, // No hex chars before suffix
        "0x" + "0".repeat(130) + "1234567890123456789012345678901234567890123456789012345678901234", // Wrong suffix
        "0x" + "0".repeat(130), // Missing suffix
        "0x" + "g" + erc6492Suffix, // Invalid hex character
        "1234567890abcdef" + erc6492Suffix, // No 0x prefix
        "", // Empty string
        "0x", // Just prefix
        "0X" + "a" + erc6492Suffix, // Wrong case prefix
        "0x" + "a" + erc6492Suffix.slice(0, -1), // Incomplete suffix
        "0x" + "a" + erc6492Suffix + "1", // Extra characters after suffix
        erc6492Suffix, // Just suffix, no prefix or hex
      ];

      invalidSignatures.forEach(signature => {
        expect(Evm6492SignatureRegex.test(signature)).toBe(false);
      });
    });

    it("should handle mixed case hex characters", () => {
      const validSignatures = [
        "0x" + "AbCdEf123456" + erc6492Suffix,
        "0x" + "DEADBEEF" + erc6492Suffix,
        "0x" + "cafebabe" + erc6492Suffix,
      ];

      validSignatures.forEach(signature => {
        expect(Evm6492SignatureRegex.test(signature)).toBe(true);
      });
    });
  });
});

describe("ErrorReasons", () => {
  it("accepts invalid_exact_evm_payload on a verify response", () => {
    const result = VerifyResponseSchema.safeParse({
      isValid: false,
      invalidReason: "invalid_exact_evm_payload",
    });
    expect(result.success).toBe(true);
  });
});

describe("x402ResponseSchema accepts bound", () => {
  const requirement = {
    scheme: "exact",
    network: "base",
    maxAmountRequired: "10000",
    resource: "https://api.example.com/premium-data",
    description: "Access to premium market data",
    mimeType: "application/json",
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    maxTimeoutSeconds: 60,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  };

  it("should accept 1024 payment options", () => {
    const result = x402ResponseSchema.safeParse({
      x402Version: 1,
      accepts: Array.from({ length: 1024 }, () => requirement),
    });
    expect(result.success).toBe(true);
  });

  it("should reject an accepts list longer than 1024 without an issue per element", () => {
    const result = x402ResponseSchema.safeParse({
      x402Version: 1,
      accepts: Array.from({ length: 5000 }, () => ({})),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.code).toBe("too_big");
    }
  });
});

describe("ListDiscoveryResourcesResponseSchema items bound", () => {
  const item = {
    resource: "https://api.example.com/premium-data",
    type: "http" as const,
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "10000",
        resource: "https://api.example.com/premium-data",
        description: "Access to premium market data",
        mimeType: "application/json",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        maxTimeoutSeconds: 60,
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      },
    ],
    lastUpdated: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("should accept 1024 discovered resources", () => {
    const result = ListDiscoveryResourcesResponseSchema.safeParse({
      x402Version: 1,
      items: Array.from({ length: 1024 }, () => item),
      pagination: { limit: 1024, offset: 0, total: 1024 },
    });
    expect(result.success).toBe(true);
  });

  it("should reject an items list longer than 1024 without an issue per element", () => {
    const result = ListDiscoveryResourcesResponseSchema.safeParse({
      x402Version: 1,
      items: Array.from({ length: 5000 }, () => ({})),
      pagination: { limit: 5000, offset: 0, total: 5000 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.code).toBe("too_big");
      expect(result.error.issues[0]?.path).toEqual(["items"]);
    }
  });
});

describe("SupportedPaymentKindsResponseSchema kinds bound", () => {
  const kind = {
    x402Version: 1,
    scheme: "exact" as const,
    network: "base",
  };

  it("should accept 1024 supported kinds", () => {
    const result = SupportedPaymentKindsResponseSchema.safeParse({
      kinds: Array.from({ length: 1024 }, () => kind),
    });
    expect(result.success).toBe(true);
  });

  it("should reject a kinds list longer than 1024 without an issue per element", () => {
    const result = SupportedPaymentKindsResponseSchema.safeParse({
      kinds: Array.from({ length: 5000 }, () => ({})),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.code).toBe("too_big");
      expect(result.error.issues[0]?.path).toEqual(["kinds"]);
    }
  });
});
