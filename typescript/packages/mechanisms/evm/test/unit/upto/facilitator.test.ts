import { describe, it, expect, beforeEach, vi } from "vitest";
import { UptoEvmScheme } from "../../../src/upto/facilitator/scheme";
import { verifyUptoPermit2, settleUptoPermit2 } from "../../../src/upto/facilitator/permit2";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { x402UptoPermit2ProxyAddress } from "../../../src/constants";
import {
  ErrPermit2AmountMismatch,
  ErrUptoAmountExceedsPermitted,
  ErrUptoFacilitatorMismatch,
  ErrUptoSettlementExceedsAmount,
  ErrUptoUnauthorizedFacilitator,
  ErrUptoInvalidScheme,
  ErrUptoNetworkMismatch,
} from "../../../src/upto/facilitator/errors";
import type { UptoPermit2Payload } from "../../../src/types";
import { ERC20_APPROVAL_GAS_SPONSORING_KEY } from "../../../src/upto/extensions";

vi.mock("viem", async importOriginal => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    parseTransaction: vi.fn(),
    recoverTransactionAddress: vi.fn(),
  };
});

const FACILITATOR_ADDRESS = "0xFAC11174700123456789012345678901234aBCDe" as `0x${string}`;

const now = () => Math.floor(Date.now() / 1000);

function makePermit2Payload(overrides?: Partial<UptoPermit2Payload>): UptoPermit2Payload {
  const base: UptoPermit2Payload = {
    signature: "0xmocksig" as `0x${string}`,
    permit2Authorization: {
      from: "0x1234567890123456789012345678901234567890",
      permitted: {
        token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "1000000",
      },
      spender: x402UptoPermit2ProxyAddress,
      nonce: "12345",
      deadline: (now() + 3600).toString(),
      witness: {
        to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        facilitator: FACILITATOR_ADDRESS,
        validAfter: (now() - 600).toString(),
      },
    },
  };
  return { ...base, ...overrides };
}

function makePayload(
  permit2?: UptoPermit2Payload,
  acceptedOverrides?: Record<string, unknown>,
): PaymentPayload {
  const p2 = permit2 ?? makePermit2Payload();
  return {
    x402Version: 2,
    accepted: { scheme: "upto", network: "eip155:8453", ...acceptedOverrides },
    payload: p2,
  } as PaymentPayload;
}

function makeRequirements(overrides?: Partial<PaymentRequirements>): PaymentRequirements {
  return {
    scheme: "upto",
    network: "eip155:8453",
    amount: "1000000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "permit2", facilitatorAddress: FACILITATOR_ADDRESS },
    ...overrides,
  };
}

describe("UptoEvmScheme (Facilitator)", () => {
  let mockSigner: FacilitatorEvmSigner;
  let scheme: UptoEvmScheme;

  beforeEach(() => {
    mockSigner = {
      getAddresses: () => [FACILITATOR_ADDRESS],
      readContract: vi.fn().mockResolvedValue(BigInt("999999999999999999")),
      verifyTypedData: vi.fn().mockResolvedValue(true),
      writeContract: vi.fn().mockResolvedValue("0xtxhash1234" as `0x${string}`),
      sendTransaction: vi.fn(),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
      getCode: vi.fn(),
    };
    scheme = new UptoEvmScheme(mockSigner);
  });

  describe("Construction", () => {
    it("should create instance with scheme=upto", () => {
      expect(scheme).toBeDefined();
      expect(scheme.scheme).toBe("upto");
    });
  });

  describe("getExtra", () => {
    it("should return facilitatorAddress from signer", () => {
      const extra = scheme.getExtra("eip155:8453");
      expect(extra).toEqual({ facilitatorAddress: FACILITATOR_ADDRESS });
    });
  });

  describe("verify", () => {
    it("should return isValid=true for a valid payload", async () => {
      const result = await scheme.verify(makePayload(), makeRequirements());

      expect(result.isValid).toBe(true);
      expect(result.payer).toBe("0x1234567890123456789012345678901234567890");
      expect(mockSigner.verifyTypedData).toHaveBeenCalled();
    });

    it("should verify with uptoPermit2WitnessTypes containing facilitator", async () => {
      await scheme.verify(makePayload(), makeRequirements());

      const callArgs = (mockSigner.verifyTypedData as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const witnessType = callArgs.types.Witness;
      expect(witnessType).toEqual([
        { name: "to", type: "address" },
        { name: "facilitator", type: "address" },
        { name: "validAfter", type: "uint256" },
      ]);
    });

    it("should reject if scheme is not upto", async () => {
      const payload = makePayload(undefined, { scheme: "exact" });
      const requirements = makeRequirements({ scheme: "exact" as any });

      const result = await scheme.verify(payload, requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ErrUptoInvalidScheme);
    });

    it("should reject if network mismatches", async () => {
      const payload = makePayload(undefined, { network: "eip155:1" });
      const requirements = makeRequirements({ network: "eip155:8453" as any });

      const result = await scheme.verify(payload, requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ErrUptoNetworkMismatch);
    });

    it("should reject if spender is not x402UptoPermit2ProxyAddress", async () => {
      const p2 = makePermit2Payload();
      p2.permit2Authorization.spender = "0x0000000000000000000000000000000000000001";
      const payload = makePayload(p2);

      const result = await scheme.verify(payload, makeRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_permit2_spender");
    });

    it("should reject if facilitator in witness does not match signer", async () => {
      const p2 = makePermit2Payload();
      p2.permit2Authorization.witness.facilitator = "0x0000000000000000000000000000000000000099";
      const payload = makePayload(p2);

      const result = await scheme.verify(payload, makeRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ErrUptoFacilitatorMismatch);
    });

    it("should reject if deadline is expired", async () => {
      const p2 = makePermit2Payload();
      p2.permit2Authorization.deadline = "1";
      const payload = makePayload(p2);

      const result = await scheme.verify(payload, makeRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("permit2_deadline_expired");
    });

    it("should reject if validAfter is in the future", async () => {
      const p2 = makePermit2Payload();
      p2.permit2Authorization.witness.validAfter = (now() + 3600).toString();
      const payload = makePayload(p2);

      const result = await scheme.verify(payload, makeRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("permit2_not_yet_valid");
    });

    it("should reject if token mismatches", async () => {
      const p2 = makePermit2Payload();
      p2.permit2Authorization.permitted.token = "0x0000000000000000000000000000000000000099";
      const payload = makePayload(p2);

      const result = await scheme.verify(payload, makeRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("permit2_token_mismatch");
    });

    it("should reject if witness.to doesn't match payTo", async () => {
      const p2 = makePermit2Payload();
      p2.permit2Authorization.witness.to = "0x0000000000000000000000000000000000000001";
      const payload = makePayload(p2);

      const result = await scheme.verify(payload, makeRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_permit2_recipient_mismatch");
    });

    it("should PASS when permitted.amount equals requirements.amount", async () => {
      const result = await scheme.verify(makePayload(), makeRequirements());

      expect(result.isValid).toBe(true);
    });

    it("should FAIL when permitted.amount !== requirements.amount (too low)", async () => {
      const requirements = makeRequirements({ amount: "5000000" });

      const result = await scheme.verify(makePayload(), requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ErrPermit2AmountMismatch);
    });

    it("should FAIL when permitted.amount !== requirements.amount (too high)", async () => {
      const p2 = makePermit2Payload();
      p2.permit2Authorization.permitted.amount = "2000000";
      const result = await scheme.verify(makePayload(p2), makeRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ErrPermit2AmountMismatch);
    });

    it("should reject if signature is invalid", async () => {
      mockSigner.verifyTypedData = vi.fn().mockResolvedValue(false);

      const result = await scheme.verify(makePayload(), makeRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_permit2_signature");
    });

    it("should reject non-Permit2 payload via scheme wrapper with unsupported_payload_type", async () => {
      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: { scheme: "upto", network: "eip155:8453" },
        payload: {
          authorization: {
            from: "0x1234567890123456789012345678901234567890",
            to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
            value: "1000000",
            validAfter: "0",
            validBefore: "999999999999",
            nonce: "0x00",
          },
          signature: "0x",
        },
      } as PaymentPayload;

      const result = await scheme.verify(payload, makeRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("unsupported_payload_type");
    });
  });

  describe("settle", () => {
    it("should settle successfully and return tx hash", async () => {
      const result = await scheme.settle(makePayload(), makeRequirements());

      expect(result.success).toBe(true);
      expect(result.transaction).toBe("0xtxhash1234");
      expect(result.payer).toBe("0x1234567890123456789012345678901234567890");
      expect(mockSigner.writeContract).toHaveBeenCalled();
    });

    it("should pass settlement amount to settle call", async () => {
      await scheme.settle(makePayload(), makeRequirements({ amount: "500000" }));

      const writeCall = (mockSigner.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(writeCall.functionName).toBe("settle");
      // args: [permit, amount, owner, witness, signature]
      expect(writeCall.args[1]).toBe(BigInt("500000"));
    });

    it("should include facilitator in witness for settle call", async () => {
      await scheme.settle(makePayload(), makeRequirements());

      const writeCall = (mockSigner.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // args[3] is the witness struct
      expect(writeCall.args[3].facilitator.toLowerCase()).toBe(FACILITATOR_ADDRESS.toLowerCase());
    });

    it("should return success with empty tx for zero settlement amount", async () => {
      const requirements = makeRequirements({ amount: "0" });

      const result = await scheme.settle(makePayload(), requirements);

      expect(result.success).toBe(true);
      expect(result.transaction).toBe("");
      expect(mockSigner.writeContract).not.toHaveBeenCalled();
    });

    it("should succeed when settlement amount < permitted amount (upto core feature)", async () => {
      const result = await scheme.settle(makePayload(), makeRequirements({ amount: "500000" }));

      expect(result.success).toBe(true);
      expect(result.transaction).toBe("0xtxhash1234");
      expect(mockSigner.writeContract).toHaveBeenCalled();

      const writeCall = (mockSigner.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(writeCall.functionName).toBe("settle");
      expect(writeCall.args[1]).toBe(BigInt("500000"));
    });

    it("should fail when settlement exceeds permitted amount", async () => {
      const p2 = makePermit2Payload();
      p2.permit2Authorization.permitted.amount = "1000000";
      const payload = makePayload(p2);
      const requirements = makeRequirements({ amount: "2000000" });

      const result = await scheme.settle(payload, requirements);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(ErrUptoSettlementExceedsAmount);
    });

    it("should reject non-Permit2 payload via scheme wrapper with unsupported_payload_type", async () => {
      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: { scheme: "upto", network: "eip155:8453" },
        payload: {
          authorization: {
            from: "0x1234567890123456789012345678901234567890",
            to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
            value: "1000000",
            validAfter: "0",
            validBefore: "999999999999",
            nonce: "0x00",
          },
          signature: "0x",
        },
      } as PaymentPayload;

      const result = await scheme.settle(payload, makeRequirements());

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("unsupported_payload_type");
    });
  });

  describe("settle error mapping", () => {
    it("should map Permit2612AmountMismatch revert", async () => {
      mockSigner.writeContract = vi
        .fn()
        .mockRejectedValue(new Error("execution reverted: Permit2612AmountMismatch()"));

      const result = await scheme.settle(makePayload(), makeRequirements());

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("permit2_2612_amount_mismatch");
    });

    it("should map InvalidNonce revert", async () => {
      mockSigner.writeContract = vi
        .fn()
        .mockRejectedValue(new Error("execution reverted: InvalidNonce()"));

      const result = await scheme.settle(makePayload(), makeRequirements());

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("permit2_invalid_nonce");
    });

    it("should map AmountExceedsPermitted revert", async () => {
      mockSigner.writeContract = vi
        .fn()
        .mockRejectedValue(new Error("execution reverted: AmountExceedsPermitted()"));

      const result = await scheme.settle(makePayload(), makeRequirements());

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(ErrUptoAmountExceedsPermitted);
    });

    it("should map UnauthorizedFacilitator revert", async () => {
      mockSigner.writeContract = vi
        .fn()
        .mockRejectedValue(new Error("execution reverted: UnauthorizedFacilitator()"));

      const result = await scheme.settle(makePayload(), makeRequirements());

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(ErrUptoUnauthorizedFacilitator);
    });
  });

  describe("direct function calls (verifyUptoPermit2 / settleUptoPermit2)", () => {
    it("verifyUptoPermit2 returns isValid=true for valid input", async () => {
      const p2 = makePermit2Payload();
      const result = await verifyUptoPermit2(mockSigner, makePayload(p2), makeRequirements(), p2);

      expect(result.isValid).toBe(true);
    });

    it("settleUptoPermit2 returns success for zero amount", async () => {
      const p2 = makePermit2Payload();
      const result = await settleUptoPermit2(
        mockSigner,
        makePayload(p2),
        makeRequirements({ amount: "0" }),
        p2,
      );

      expect(result.success).toBe(true);
      expect(result.transaction).toBe("");
      expect(result.amount).toBe("0");
      expect(mockSigner.writeContract).not.toHaveBeenCalled();
    });

    it("settleUptoPermit2 rejects when settlement exceeds permitted", async () => {
      const p2 = makePermit2Payload();
      p2.permit2Authorization.permitted.amount = "500000";
      const result = await settleUptoPermit2(
        mockSigner,
        makePayload(p2),
        makeRequirements({ amount: "1000000" }),
        p2,
      );

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(ErrUptoSettlementExceedsAmount);
    });
  });

  describe("getSigners", () => {
    it("should return facilitator addresses from signer", () => {
      const signers = scheme.getSigners("eip155:8453");
      expect(signers).toEqual([FACILITATOR_ADDRESS]);
    });
  });

  describe("verify edge cases", () => {
    it("should handle verifyTypedData throwing an exception", async () => {
      mockSigner.verifyTypedData = vi.fn().mockRejectedValue(new Error("RPC unavailable"));

      const result = await scheme.verify(makePayload(), makeRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_permit2_signature");
    });
  });

  describe("ERC-6492 / smart contract wallet signature fallback", () => {
    it("should reject undeployed EOA with invalid signature", async () => {
      mockSigner.verifyTypedData = vi.fn().mockResolvedValue(false);
      mockSigner.getCode = vi.fn().mockResolvedValue("0x");

      const result = await scheme.verify(makePayload(), makeRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_permit2_signature");
    });

    it("should fall through to simulation for deployed smart contract when verifyTypedData returns false", async () => {
      mockSigner.verifyTypedData = vi.fn().mockResolvedValue(false);
      mockSigner.getCode = vi.fn().mockResolvedValue("0x608060405234");

      const result = await scheme.verify(makePayload(), makeRequirements());

      expect(result.isValid).toBe(true);
    });

    it("should fall through to simulation for deployed smart contract when verifyTypedData throws", async () => {
      mockSigner.verifyTypedData = vi.fn().mockRejectedValue(new Error("unsupported"));
      mockSigner.getCode = vi.fn().mockResolvedValue("0x608060405234");

      const result = await scheme.verify(makePayload(), makeRequirements());

      expect(result.isValid).toBe(true);
    });

    it("should reject undeployed contract when verifyTypedData throws", async () => {
      mockSigner.verifyTypedData = vi.fn().mockRejectedValue(new Error("unsupported"));
      mockSigner.getCode = vi.fn().mockResolvedValue("0x");

      const result = await scheme.verify(makePayload(), makeRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_permit2_signature");
    });
  });

  describe("settle receipt handling", () => {
    it("should fail when transaction receipt returns reverted status", async () => {
      mockSigner.waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: "reverted" });

      const result = await scheme.settle(makePayload(), makeRequirements());

      expect(result.success).toBe(false);
    });
  });

  describe("EIP-2612 Gas Sponsoring - Settlement", () => {
    const eip2612Requirements = makeRequirements();

    function makeEip2612Extension() {
      const ts = Math.floor(Date.now() / 1000);
      return {
        eip2612GasSponsoring: {
          info: {
            from: "0x1234567890123456789012345678901234567890",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
            amount:
              "115792089237316195423570985008687907853269984665640564039457584007913129639935",
            nonce: "0",
            deadline: (ts + 300).toString(),
            signature: "0x" + "ab".repeat(32) + "cd".repeat(32) + "1b",
            version: "1",
          },
          schema: {},
        },
      };
    }

    function makePayloadWithExtensions(extensions?: Record<string, unknown>): PaymentPayload {
      const p2 = makePermit2Payload();
      return {
        x402Version: 2,
        accepted: { scheme: "upto", network: "eip155:8453" },
        payload: p2,
        resource: { url: "https://test.com", description: "", mimeType: "" },
        ...(extensions ? { extensions } : {}),
      } as PaymentPayload;
    }

    it("should call settleWithPermit when EIP-2612 extension is present", async () => {
      mockSigner.readContract = vi.fn().mockResolvedValue(undefined);

      const payload = makePayloadWithExtensions(makeEip2612Extension());
      const result = await scheme.settle(payload, eip2612Requirements);

      expect(result.success).toBe(true);
      expect(result.transaction).toBe("0xtxhash1234");

      const writeCall = (mockSigner.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(writeCall.functionName).toBe("settleWithPermit");
    });

    it("should call settle (not settleWithPermit) when no EIP-2612 extension", async () => {
      mockSigner.readContract = vi.fn().mockResolvedValue(BigInt("999999999999999999"));

      const payload = makePayloadWithExtensions();
      const result = await scheme.settle(payload, eip2612Requirements);

      expect(result.success).toBe(true);

      const writeCall = (mockSigner.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(writeCall.functionName).toBe("settle");
    });

    it("should pass correct EIP-2612 permit struct to settleWithPermit", async () => {
      mockSigner.readContract = vi.fn().mockResolvedValue(undefined);

      const payload = makePayloadWithExtensions(makeEip2612Extension());
      await scheme.settle(payload, eip2612Requirements);

      const writeCall = (mockSigner.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(writeCall.functionName).toBe("settleWithPermit");

      const permit2612Struct = writeCall.args[0];
      expect(permit2612Struct.value).toBeDefined();
      expect(permit2612Struct.deadline).toBeDefined();
      expect(permit2612Struct.r).toBeDefined();
      expect(permit2612Struct.s).toBeDefined();
      expect(permit2612Struct.v).toBeDefined();
      expect(typeof permit2612Struct.v).toBe("number");
    });

    it("should include settlement amount in settleWithPermit args", async () => {
      mockSigner.readContract = vi.fn().mockResolvedValue(undefined);

      const payload = makePayloadWithExtensions(makeEip2612Extension());
      await scheme.settle(payload, makeRequirements({ amount: "500000" }));

      const writeCall = (mockSigner.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(writeCall.functionName).toBe("settleWithPermit");
      // settleWithPermit args: [permit2612Struct, permit, amount, owner, witness, signature]
      expect(writeCall.args[2]).toBe(BigInt("500000"));
    });
  });

  describe("ERC-20 Approval Gas Sponsoring - Verify", () => {
    const PAYER = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const TOKEN_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
    const MOCK_SIGNED_TX = "0x02f8ab0102030405060708" as `0x${string}`;

    const APPROVE_CALLDATA =
      `0x095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3` +
      `ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`;

    const erc20VerifyRequirements: PaymentRequirements = {
      scheme: "upto",
      network: "eip155:8453",
      amount: "1000000",
      asset: TOKEN_ADDRESS,
      payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: "permit2", facilitatorAddress: FACILITATOR_ADDRESS },
    };

    function makeErc20UptoPayload(extensions?: Record<string, unknown>): PaymentPayload {
      const ts = Math.floor(Date.now() / 1000);
      return {
        x402Version: 2,
        payload: {
          signature: "0x" + "ab".repeat(32) + "cd".repeat(32) + "1b",
          permit2Authorization: {
            from: PAYER,
            permitted: {
              token: TOKEN_ADDRESS,
              amount: erc20VerifyRequirements.amount,
            },
            spender: x402UptoPermit2ProxyAddress,
            nonce: "99999",
            deadline: (ts + 300).toString(),
            witness: {
              to: erc20VerifyRequirements.payTo,
              facilitator: FACILITATOR_ADDRESS,
              validAfter: (ts - 600).toString(),
            },
          },
        } as UptoPermit2Payload,
        accepted: { scheme: "upto", network: "eip155:8453" },
        resource: { url: "https://test.com", description: "", mimeType: "" },
        ...(extensions ? { extensions } : {}),
      } as PaymentPayload;
    }

    function makeValidErc20Extension() {
      return {
        erc20ApprovalGasSponsoring: {
          info: {
            from: PAYER,
            asset: TOKEN_ADDRESS,
            spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
            amount:
              "115792089237316195423570985008687907853269984665640564039457584007913129639935",
            signedTransaction: MOCK_SIGNED_TX,
            version: "1",
          },
          schema: {},
        },
      };
    }

    function makeErc20Context() {
      return {
        getExtension: vi.fn().mockImplementation((key: string) => {
          if (key === ERC20_APPROVAL_GAS_SPONSORING_KEY) {
            return { key: ERC20_APPROVAL_GAS_SPONSORING_KEY };
          }
          return undefined;
        }),
      };
    }

    it("should reject when ERC-20 extension has invalid format (bad address)", async () => {
      mockSigner.readContract = vi.fn().mockResolvedValue(undefined);

      const payload = makeErc20UptoPayload({
        erc20ApprovalGasSponsoring: {
          info: {
            from: "not-an-address",
            asset: TOKEN_ADDRESS,
            spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
            amount: "100",
            signedTransaction: MOCK_SIGNED_TX,
            version: "1",
          },
          schema: {},
        },
      });

      const result = await scheme.verify(payload, erc20VerifyRequirements, makeErc20Context());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_erc20_approval_extension_format");
    });

    it("should reject when ERC-20 extension from doesn't match payer", async () => {
      mockSigner.readContract = vi.fn().mockResolvedValue(undefined);

      const payload = makeErc20UptoPayload({
        erc20ApprovalGasSponsoring: {
          info: {
            from: "0x0000000000000000000000000000000000000001",
            asset: TOKEN_ADDRESS,
            spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
            amount: "100",
            signedTransaction: MOCK_SIGNED_TX,
            version: "1",
          },
          schema: {},
        },
      });

      const result = await scheme.verify(payload, erc20VerifyRequirements, makeErc20Context());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("erc20_approval_from_mismatch");
    });

    it("should accept when valid ERC-20 extension present and simulation succeeds", async () => {
      mockSigner.readContract = vi.fn().mockResolvedValue(undefined);

      const { parseTransaction, recoverTransactionAddress } = await import("viem");
      vi.mocked(parseTransaction).mockReturnValue({
        to: TOKEN_ADDRESS,
        data: APPROVE_CALLDATA as `0x${string}`,
      } as any);
      vi.mocked(recoverTransactionAddress).mockResolvedValue(PAYER);

      const mockSimulateTransactions = vi.fn().mockResolvedValue(true);

      const mockContext = {
        getExtension: vi.fn().mockImplementation((key: string) => {
          if (key === ERC20_APPROVAL_GAS_SPONSORING_KEY) {
            return {
              key: ERC20_APPROVAL_GAS_SPONSORING_KEY,
              signer: {
                ...mockSigner,
                sendTransactions: vi.fn(),
                simulateTransactions: mockSimulateTransactions,
              },
            };
          }
          return undefined;
        }),
      };

      const result = await scheme.verify(
        makeErc20UptoPayload(makeValidErc20Extension()),
        erc20VerifyRequirements,
        mockContext,
      );

      expect(result.isValid).toBe(true);
    });
  });

  describe("ERC-20 Approval Gas Sponsoring - Settlement", () => {
    const PAYER = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const TOKEN_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
    const MOCK_SIGNED_TX = "0x02f8ab0102030405060708" as `0x${string}`;

    const APPROVE_CALLDATA =
      `0x095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3` +
      `ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`;

    const erc20SettleRequirements: PaymentRequirements = {
      scheme: "upto",
      network: "eip155:8453",
      amount: "1000000",
      asset: TOKEN_ADDRESS,
      payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: "permit2", facilitatorAddress: FACILITATOR_ADDRESS },
    };

    function makeErc20UptoPayload(extensions?: Record<string, unknown>): PaymentPayload {
      const ts = Math.floor(Date.now() / 1000);
      return {
        x402Version: 2,
        payload: {
          signature: "0x" + "ab".repeat(32) + "cd".repeat(32) + "1b",
          permit2Authorization: {
            from: PAYER,
            permitted: {
              token: TOKEN_ADDRESS,
              amount: erc20SettleRequirements.amount,
            },
            spender: x402UptoPermit2ProxyAddress,
            nonce: "99999",
            deadline: (ts + 300).toString(),
            witness: {
              to: erc20SettleRequirements.payTo,
              facilitator: FACILITATOR_ADDRESS,
              validAfter: (ts - 600).toString(),
            },
          },
        } as UptoPermit2Payload,
        accepted: { scheme: "upto", network: "eip155:8453" },
        resource: { url: "https://test.com", description: "", mimeType: "" },
        ...(extensions ? { extensions } : {}),
      } as PaymentPayload;
    }

    function makeValidErc20Extension() {
      return {
        erc20ApprovalGasSponsoring: {
          info: {
            from: PAYER,
            asset: TOKEN_ADDRESS,
            spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
            amount:
              "115792089237316195423570985008687907853269984665640564039457584007913129639935",
            signedTransaction: MOCK_SIGNED_TX,
            version: "1",
          },
          schema: {},
        },
      };
    }

    function makeErc20SettleContext() {
      const SETTLE_TX_HASH = "0xsettle_tx_hash_mock" as `0x${string}`;
      const mockSendTransactions = vi.fn().mockResolvedValue([SETTLE_TX_HASH]);
      const mockExtWaitForReceipt = vi.fn().mockResolvedValue({ status: "success" });

      const mockContext = {
        getExtension: vi.fn().mockImplementation((key: string) => {
          if (key === ERC20_APPROVAL_GAS_SPONSORING_KEY) {
            return {
              key: ERC20_APPROVAL_GAS_SPONSORING_KEY,
              signer: {
                getAddresses: () => [FACILITATOR_ADDRESS],
                readContract: mockSigner.readContract,
                verifyTypedData: mockSigner.verifyTypedData,
                writeContract: vi.fn(),
                sendTransaction: vi.fn(),
                waitForTransactionReceipt: mockExtWaitForReceipt,
                getCode: vi.fn().mockResolvedValue("0x"),
                sendTransactions: mockSendTransactions,
              },
            };
          }
          return undefined;
        }),
      };

      return { mockContext, mockSendTransactions };
    }

    it("should broadcast approval tx via extension signer then settle", async () => {
      const { parseTransaction, recoverTransactionAddress } = await import("viem");
      vi.mocked(parseTransaction).mockReturnValue({
        to: TOKEN_ADDRESS,
        data: APPROVE_CALLDATA as `0x${string}`,
      } as any);
      vi.mocked(recoverTransactionAddress).mockResolvedValue(PAYER);

      mockSigner.readContract = vi.fn().mockResolvedValue(undefined);

      const { mockContext, mockSendTransactions } = makeErc20SettleContext();

      const result = await scheme.settle(
        makeErc20UptoPayload(makeValidErc20Extension()),
        erc20SettleRequirements,
        mockContext,
      );

      expect(mockSendTransactions).toHaveBeenCalled();
      const transactions = mockSendTransactions.mock.calls[0][0];
      expect(transactions[0]).toBe(MOCK_SIGNED_TX);
      expect(transactions[1]).toHaveProperty("to");
      expect(transactions[1]).toHaveProperty("data");

      expect(mockSigner.writeContract).not.toHaveBeenCalled();

      expect(result.success).toBe(true);
    });

    it("should include settlement amount in ERC-20 approval settle response", async () => {
      const { parseTransaction, recoverTransactionAddress } = await import("viem");
      vi.mocked(parseTransaction).mockReturnValue({
        to: TOKEN_ADDRESS,
        data: APPROVE_CALLDATA as `0x${string}`,
      } as any);
      vi.mocked(recoverTransactionAddress).mockResolvedValue(PAYER);

      mockSigner.readContract = vi.fn().mockResolvedValue(undefined);

      const { mockContext } = makeErc20SettleContext();

      const result = await scheme.settle(
        makeErc20UptoPayload(makeValidErc20Extension()),
        makeRequirements({
          amount: "750000",
          asset: TOKEN_ADDRESS,
          extra: { assetTransferMethod: "permit2", facilitatorAddress: FACILITATOR_ADDRESS },
        }),
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.amount).toBe("750000");
    });
  });
});
