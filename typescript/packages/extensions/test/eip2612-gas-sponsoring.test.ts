/**
 * Tests for EIP-2612 Gas Sponsoring Extension
 */

import { describe, it, expect } from "vitest";
import {
  EIP2612_GAS_SPONSORING,
  declareEip2612GasSponsoringExtension,
  extractEip2612GasSponsoringInfo,
  validateEip2612GasSponsoringInfo,
} from "../src/eip2612-gas-sponsoring/index";
import type {
  Eip2612GasSponsoringInfo,
  Eip2612GasSponsoringExtension,
} from "../src/eip2612-gas-sponsoring/types";
import type { PaymentPayload } from "@x402/core/types";

describe("EIP-2612 Gas Sponsoring Extension", () => {
  describe("EIP2612_GAS_SPONSORING constant", () => {
    it("should export the correct extension identifier", () => {
      expect(EIP2612_GAS_SPONSORING.key).toBe("eip2612GasSponsoring");
    });
  });

  describe("declareEip2612GasSponsoringExtension", () => {
    it("should create a valid extension declaration", () => {
      const result = declareEip2612GasSponsoringExtension();

      expect(result).toHaveProperty("eip2612GasSponsoring");
      const extension = result.eip2612GasSponsoring;

      // Check info contains server-side defaults
      expect(extension.info).toHaveProperty("description");
      expect(extension.info).toHaveProperty("version", "1");

      // Check schema has required fields
      expect(extension.schema).toHaveProperty("$schema");
      expect(extension.schema).toHaveProperty("type", "object");
      expect(extension.schema).toHaveProperty("properties");
      expect(extension.schema).toHaveProperty("required");

      const required = extension.schema.required as string[];
      expect(required).toContain("from");
      expect(required).toContain("asset");
      expect(required).toContain("spender");
      expect(required).toContain("amount");
      expect(required).toContain("nonce");
      expect(required).toContain("deadline");
      expect(required).toContain("signature");
      expect(required).toContain("version");
    });
  });

  describe("extractEip2612GasSponsoringInfo", () => {
    const validInfo: Eip2612GasSponsoringInfo = {
      from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      amount: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      nonce: "0",
      deadline: "1740672154",
      signature:
        "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
      version: "1",
    };

    it("should extract info from a valid payload", () => {
      const payload = {
        x402Version: 2,
        extensions: {
          eip2612GasSponsoring: {
            info: validInfo,
            schema: {},
          } as Eip2612GasSponsoringExtension,
        },
      } as unknown as PaymentPayload;

      const result = extractEip2612GasSponsoringInfo(payload);
      expect(result).not.toBeNull();
      expect(result!.from).toBe(validInfo.from);
      expect(result!.asset).toBe(validInfo.asset);
      expect(result!.spender).toBe(validInfo.spender);
      expect(result!.signature).toBe(validInfo.signature);
    });

    it("should return null when no extensions", () => {
      const payload = {
        x402Version: 2,
      } as unknown as PaymentPayload;

      const result = extractEip2612GasSponsoringInfo(payload);
      expect(result).toBeNull();
    });

    it("should return null when extension is missing", () => {
      const payload = {
        x402Version: 2,
        extensions: {},
      } as unknown as PaymentPayload;

      const result = extractEip2612GasSponsoringInfo(payload);
      expect(result).toBeNull();
    });

    it("should return null when info is incomplete", () => {
      const payload = {
        x402Version: 2,
        extensions: {
          eip2612GasSponsoring: {
            info: {
              description: "test",
              version: "1",
            },
            schema: {},
          },
        },
      } as unknown as PaymentPayload;

      const result = extractEip2612GasSponsoringInfo(payload);
      expect(result).toBeNull();
    });
  });

  describe("validateEip2612GasSponsoringInfo", () => {
    it("should validate correct info", () => {
      const info: Eip2612GasSponsoringInfo = {
        from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        amount: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        nonce: "0",
        deadline: "1740672154",
        signature: "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a12832597641736",
        version: "1",
      };

      expect(validateEip2612GasSponsoringInfo(info)).toBe(true);
    });

    it("should reject invalid address format", () => {
      const info: Eip2612GasSponsoringInfo = {
        from: "invalid-address",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        amount: "100",
        nonce: "0",
        deadline: "1740672154",
        signature: "0xabc",
        version: "1",
      };

      expect(validateEip2612GasSponsoringInfo(info)).toBe(false);
    });

    it("should reject non-numeric amount", () => {
      const info: Eip2612GasSponsoringInfo = {
        from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        amount: "not-a-number",
        nonce: "0",
        deadline: "1740672154",
        signature: "0xabc",
        version: "1",
      };

      expect(validateEip2612GasSponsoringInfo(info)).toBe(false);
    });
  });
});
