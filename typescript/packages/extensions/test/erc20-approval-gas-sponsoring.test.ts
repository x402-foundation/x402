/**
 * Tests for ERC-20 Approval Gas Sponsoring Extension
 */

import { describe, it, expect } from "vitest";
import {
  ERC20_APPROVAL_GAS_SPONSORING,
  declareErc20ApprovalGasSponsoringExtension,
  extractErc20ApprovalGasSponsoringInfo,
  validateErc20ApprovalGasSponsoringInfo,
} from "../src/erc20-approval-gas-sponsoring/index";
import type {
  Erc20ApprovalGasSponsoringInfo,
  Erc20ApprovalGasSponsoringExtension,
} from "../src/erc20-approval-gas-sponsoring/types";
import type { PaymentPayload } from "@x402/core/types";

describe("ERC-20 Approval Gas Sponsoring Extension", () => {
  describe("ERC20_APPROVAL_GAS_SPONSORING constant", () => {
    it("should export the correct extension identifier", () => {
      expect(ERC20_APPROVAL_GAS_SPONSORING.key).toBe("erc20ApprovalGasSponsoring");
    });
  });

  describe("declareErc20ApprovalGasSponsoringExtension", () => {
    it("should create a valid extension declaration", () => {
      const result = declareErc20ApprovalGasSponsoringExtension();

      expect(result).toHaveProperty("erc20ApprovalGasSponsoring");
      const extension = result.erc20ApprovalGasSponsoring;

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
      expect(required).toContain("signedTransaction");
      expect(required).toContain("version");
    });

    it("should NOT include nonce, deadline, or signature in required fields", () => {
      const result = declareErc20ApprovalGasSponsoringExtension();
      const required = result.erc20ApprovalGasSponsoring.schema.required as string[];

      expect(required).not.toContain("nonce");
      expect(required).not.toContain("deadline");
      expect(required).not.toContain("signature");
    });

    it("should have correct schema properties for signedTransaction", () => {
      const result = declareErc20ApprovalGasSponsoringExtension();
      const properties = result.erc20ApprovalGasSponsoring.schema.properties as Record<
        string,
        unknown
      >;

      expect(properties).toHaveProperty("signedTransaction");
      const signedTxSchema = properties.signedTransaction as Record<string, unknown>;
      expect(signedTxSchema.type).toBe("string");
      // signedTransaction uses hex pattern
      expect(signedTxSchema.pattern).toContain("0x");
    });
  });

  describe("extractErc20ApprovalGasSponsoringInfo", () => {
    const validInfo: Erc20ApprovalGasSponsoringInfo = {
      from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      asset: "0xeED520980fC7C7B4eB379B96d61CEdea2423005a",
      spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      amount: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      signedTransaction:
        "0x02f8708501234567890185012345678901850174876e80082011094eed520980fc7c7b4eb379b96d61cedea2423005a80b844095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      version: "1",
    };

    it("should extract info from a valid payload", () => {
      const payload = {
        x402Version: 2,
        extensions: {
          erc20ApprovalGasSponsoring: {
            info: validInfo,
            schema: {},
          } as Erc20ApprovalGasSponsoringExtension,
        },
      } as unknown as PaymentPayload;

      const result = extractErc20ApprovalGasSponsoringInfo(payload);
      expect(result).not.toBeNull();
      expect(result!.from).toBe(validInfo.from);
      expect(result!.asset).toBe(validInfo.asset);
      expect(result!.spender).toBe(validInfo.spender);
      expect(result!.signedTransaction).toBe(validInfo.signedTransaction);
    });

    it("should return null when no extensions", () => {
      const payload = {
        x402Version: 2,
      } as unknown as PaymentPayload;

      const result = extractErc20ApprovalGasSponsoringInfo(payload);
      expect(result).toBeNull();
    });

    it("should return null when extension is missing", () => {
      const payload = {
        x402Version: 2,
        extensions: {},
      } as unknown as PaymentPayload;

      const result = extractErc20ApprovalGasSponsoringInfo(payload);
      expect(result).toBeNull();
    });

    it("should return null when info is incomplete (only server-side fields)", () => {
      const payload = {
        x402Version: 2,
        extensions: {
          erc20ApprovalGasSponsoring: {
            info: {
              description: "test",
              version: "1",
            },
            schema: {},
          },
        },
      } as unknown as PaymentPayload;

      const result = extractErc20ApprovalGasSponsoringInfo(payload);
      expect(result).toBeNull();
    });

    it("should return null when signedTransaction is missing", () => {
      const payload = {
        x402Version: 2,
        extensions: {
          erc20ApprovalGasSponsoring: {
            info: {
              from: validInfo.from,
              asset: validInfo.asset,
              spender: validInfo.spender,
              amount: validInfo.amount,
              // signedTransaction is missing
              version: validInfo.version,
            },
            schema: {},
          },
        },
      } as unknown as PaymentPayload;

      const result = extractErc20ApprovalGasSponsoringInfo(payload);
      expect(result).toBeNull();
    });
  });

  describe("validateErc20ApprovalGasSponsoringInfo", () => {
    it("should validate correct info", () => {
      const info: Erc20ApprovalGasSponsoringInfo = {
        from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        asset: "0xeED520980fC7C7B4eB379B96d61CEdea2423005a",
        spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        amount: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        signedTransaction: "0x02f8ab",
        version: "1",
      };

      expect(validateErc20ApprovalGasSponsoringInfo(info)).toBe(true);
    });

    it("should reject invalid from address format", () => {
      const info: Erc20ApprovalGasSponsoringInfo = {
        from: "invalid-address",
        asset: "0xeED520980fC7C7B4eB379B96d61CEdea2423005a",
        spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        amount: "100",
        signedTransaction: "0x02ab",
        version: "1",
      };

      expect(validateErc20ApprovalGasSponsoringInfo(info)).toBe(false);
    });

    it("should reject non-numeric amount", () => {
      const info: Erc20ApprovalGasSponsoringInfo = {
        from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        asset: "0xeED520980fC7C7B4eB379B96d61CEdea2423005a",
        spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        amount: "not-a-number",
        signedTransaction: "0x02ab",
        version: "1",
      };

      expect(validateErc20ApprovalGasSponsoringInfo(info)).toBe(false);
    });

    it("should reject invalid signedTransaction (not hex)", () => {
      const info: Erc20ApprovalGasSponsoringInfo = {
        from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        asset: "0xeED520980fC7C7B4eB379B96d61CEdea2423005a",
        spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        amount: "100",
        signedTransaction: "not-a-hex-string",
        version: "1",
      };

      expect(validateErc20ApprovalGasSponsoringInfo(info)).toBe(false);
    });

    it("should reject invalid spender address", () => {
      const info: Erc20ApprovalGasSponsoringInfo = {
        from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        asset: "0xeED520980fC7C7B4eB379B96d61CEdea2423005a",
        spender: "not-an-address",
        amount: "100",
        signedTransaction: "0x02ab",
        version: "1",
      };

      expect(validateErc20ApprovalGasSponsoringInfo(info)).toBe(false);
    });

    it("should reject invalid version format", () => {
      const info: Erc20ApprovalGasSponsoringInfo = {
        from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        asset: "0xeED520980fC7C7B4eB379B96d61CEdea2423005a",
        spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        amount: "100",
        signedTransaction: "0x02ab",
        version: "not.a.version",
      };

      expect(validateErc20ApprovalGasSponsoringInfo(info)).toBe(false);
    });
  });
});
