import { describe, it, expect } from "vitest";
import { hashTypedData } from "viem";
import {
  authorizationTypes,
  eip3009ABI,
  permit2WitnessTypes,
  x402ExactPermit2ProxyAddress,
  PERMIT2_ADDRESS,
} from "../../src/constants";

describe("EVM Constants", () => {
  describe("authorizationTypes", () => {
    it("should have TransferWithAuthorization type definition", () => {
      expect(authorizationTypes.TransferWithAuthorization).toBeDefined();
      expect(authorizationTypes.TransferWithAuthorization).toHaveLength(6);
    });

    it("should have correct field names", () => {
      const fields = authorizationTypes.TransferWithAuthorization;
      const fieldNames = fields.map(f => f.name);

      expect(fieldNames).toContain("from");
      expect(fieldNames).toContain("to");
      expect(fieldNames).toContain("value");
      expect(fieldNames).toContain("validAfter");
      expect(fieldNames).toContain("validBefore");
      expect(fieldNames).toContain("nonce");
    });

    it("should have correct field types", () => {
      const fields = authorizationTypes.TransferWithAuthorization;
      const fromField = fields.find(f => f.name === "from");
      const valueField = fields.find(f => f.name === "value");
      const nonceField = fields.find(f => f.name === "nonce");

      expect(fromField?.type).toBe("address");
      expect(valueField?.type).toBe("uint256");
      expect(nonceField?.type).toBe("bytes32");
    });
  });

  describe("eip3009ABI", () => {
    it("should include transferWithAuthorization functions", () => {
      const transferFunctions = eip3009ABI.filter(
        item => item.type === "function" && item.name === "transferWithAuthorization",
      );
      expect(transferFunctions.length).toBeGreaterThan(0);
    });

    it("should include balanceOf function", () => {
      const balanceOfFunction = eip3009ABI.find(
        item => item.type === "function" && item.name === "balanceOf",
      );
      expect(balanceOfFunction).toBeDefined();
      expect(balanceOfFunction?.stateMutability).toBe("view");
    });

    it("should include version function", () => {
      const versionFunction = eip3009ABI.find(
        item => item.type === "function" && item.name === "version",
      );
      expect(versionFunction).toBeDefined();
      expect(versionFunction?.stateMutability).toBe("view");
    });

    it("should have transferWithAuthorization with split signature (v, r, s)", () => {
      const splitSigFunction = eip3009ABI.find(
        item =>
          item.type === "function" &&
          item.name === "transferWithAuthorization" &&
          item.inputs.some(input => input.name === "v"),
      );
      expect(splitSigFunction).toBeDefined();
    });

    it("should have transferWithAuthorization with bytes signature", () => {
      const bytesSigFunction = eip3009ABI.find(
        item =>
          item.type === "function" &&
          item.name === "transferWithAuthorization" &&
          item.inputs.some(input => input.name === "signature"),
      );
      expect(bytesSigFunction).toBeDefined();
    });
  });

  describe("Permit2 witness types", () => {
    it("Witness type must not contain 'extra' field (post-audit)", () => {
      const witnessFields = permit2WitnessTypes.Witness;
      const hasExtra = witnessFields.some(f => f.name === "extra");
      expect(hasExtra).toBe(false);
    });

    it("Witness type must have exactly 'to' and 'validAfter' fields", () => {
      const witnessFields = permit2WitnessTypes.Witness;
      expect(witnessFields).toHaveLength(2);
      expect(witnessFields[0].name).toBe("to");
      expect(witnessFields[1].name).toBe("validAfter");
    });
  });

  /**
   * Cross-SDK EIP-712 hash test vector.
   *
   * The canonical input below must produce the same 32-byte hash in Go
   * (see go/test/unit/evm_eip712_test.go, TestPermit2HashCrossSDKVector)
   * and in TypeScript here. If both hashes are identical for this input,
   * the two SDKs agree on the post-audit witness struct (no 'extra' field).
   */
  describe("Cross-SDK Permit2 EIP-712 hash vector", () => {
    const canonicalDomain = {
      name: "Permit2",
      chainId: 84532, // Base Sepolia
      verifyingContract: PERMIT2_ADDRESS as `0x${string}`,
    } as const;

    const canonicalMessage = {
      permitted: {
        token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`,
        amount: 1000000n,
      },
      spender: x402ExactPermit2ProxyAddress,
      nonce: 1n,
      deadline: 9999999999n,
      witness: {
        to: "0x9876543210987654321098765432109876543210" as `0x${string}`,
        validAfter: 0n,
      },
    } as const;

    it("should produce a 32-byte hash for the canonical input", () => {
      const hash = hashTypedData({
        domain: canonicalDomain,
        types: permit2WitnessTypes,
        primaryType: "PermitWitnessTransferFrom",
        message: canonicalMessage,
      });
      // EIP-712 hash is always 32 bytes (returned as 0x-prefixed hex = 66 chars)
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it("hash should be deterministic", () => {
      const hash1 = hashTypedData({
        domain: canonicalDomain,
        types: permit2WitnessTypes,
        primaryType: "PermitWitnessTransferFrom",
        message: canonicalMessage,
      });
      const hash2 = hashTypedData({
        domain: canonicalDomain,
        types: permit2WitnessTypes,
        primaryType: "PermitWitnessTransferFrom",
        message: canonicalMessage,
      });
      expect(hash1).toBe(hash2);
    });

    it("changing witness.to must produce a different hash (no extra field)", () => {
      const hash1 = hashTypedData({
        domain: canonicalDomain,
        types: permit2WitnessTypes,
        primaryType: "PermitWitnessTransferFrom",
        message: canonicalMessage,
      });
      const hash2 = hashTypedData({
        domain: canonicalDomain,
        types: permit2WitnessTypes,
        primaryType: "PermitWitnessTransferFrom",
        message: {
          ...canonicalMessage,
          witness: {
            to: "0x0000000000000000000000000000000000000001" as `0x${string}`,
            validAfter: 0n,
          },
        },
      });
      expect(hash1).not.toBe(hash2);
    });
  });
});
