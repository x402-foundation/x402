import { describe, it, expect, vi } from "vitest";
import { zeroAddress } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  verifyPermit2Allowance,
  validateEip2612PermitForPayment,
  simulatePermit2Settle,
} from "../../../src/shared/permit2";
import { PERMIT2_ADDRESS } from "../../../src/constants";
import { EIP2612_GAS_SPONSORING_KEY } from "../../../src/exact/extensions";
import type { FacilitatorEvmSigner } from "../../../src/signer";

const PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000000",
  asset: TOKEN,
  payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  maxTimeoutSeconds: 60,
  extra: {},
};

const basePayload = { x402Version: 2, accepted: requirements, payload: {} } as PaymentPayload;

function eip2612Payload(from = PAYER) {
  const future = String(Math.floor(Date.now() / 1000) + 3600);
  const sig = "aa".repeat(64) + "1b";
  return {
    ...basePayload,
    extensions: {
      [EIP2612_GAS_SPONSORING_KEY]: {
        info: {
          from,
          asset: TOKEN,
          spender: PERMIT2_ADDRESS,
          amount: "2000000",
          nonce: "1",
          deadline: future,
          signature: `0x${sig}`,
          version: "1",
        },
      },
    },
  } as PaymentPayload;
}

function mockSigner(allowance: bigint | "throw"): FacilitatorEvmSigner {
  return {
    getAddresses: () => [PAYER],
    readContract: vi.fn().mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "allowance") {
        if (allowance === "throw") throw new Error("rpc down");
        return allowance;
      }
      return 0n;
    }),
  } as FacilitatorEvmSigner;
}

describe("verifyPermit2Allowance", () => {
  it("returns null when Permit2 allowance already covers the payment amount", async () => {
    const result = await verifyPermit2Allowance(
      mockSigner(2_000_000n),
      basePayload,
      requirements,
      PAYER,
      TOKEN,
    );
    expect(result).toBeNull();
  });

  it("requires allowance when the read succeeds but balance is insufficient and no extension is present", async () => {
    const result = await verifyPermit2Allowance(
      mockSigner(0n),
      basePayload,
      requirements,
      PAYER,
      TOKEN,
    );
    expect(result).toEqual({
      isValid: false,
      invalidReason: "permit2_allowance_required",
      payer: PAYER,
    });
  });

  it("fails closed when allowance cannot be read and no gas-sponsoring extension applies", async () => {
    const result = await verifyPermit2Allowance(
      mockSigner("throw"),
      basePayload,
      requirements,
      PAYER,
      TOKEN,
    );
    expect(result).toEqual({
      isValid: false,
      invalidReason: "permit2_allowance_required",
      payer: PAYER,
    });
  });

  it("continues verification when allowance is low but a valid EIP-2612 extension is present", async () => {
    const result = await verifyPermit2Allowance(
      mockSigner(0n),
      eip2612Payload(),
      requirements,
      PAYER,
      TOKEN,
    );
    expect(result).toBeNull();
  });

  it("surfaces EIP-2612 validation failures instead of a generic allowance error", async () => {
    const result = await verifyPermit2Allowance(
      mockSigner(0n),
      eip2612Payload("0x0000000000000000000000000000000000000001"),
      requirements,
      PAYER,
      TOKEN,
    );
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "eip2612_from_mismatch",
      payer: PAYER,
    });
  });

  it("uses EIP-2612 sponsoring in the allowance-read error path when RPC fails", async () => {
    const result = await verifyPermit2Allowance(
      mockSigner("throw"),
      eip2612Payload(),
      requirements,
      PAYER,
      TOKEN,
    );
    expect(result).toBeNull();
  });

  it("reads allowance against the canonical Permit2 contract address", async () => {
    const signer = mockSigner(2_000_000n);
    await verifyPermit2Allowance(signer, basePayload, requirements, PAYER, TOKEN);
    expect(signer.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: TOKEN,
        functionName: "allowance",
        args: [PAYER, PERMIT2_ADDRESS],
      }),
    );
  });
});

describe("simulatePermit2Settle", () => {
  it("returns true when eth_call simulation succeeds", async () => {
    const signer = {
      readContract: vi.fn().mockResolvedValue(undefined),
    } as FacilitatorEvmSigner;
    const ok = await simulatePermit2Settle(
      { proxyAddress: "0x1111111111111111111111111111111111111111", proxyABI: [] },
      signer,
      [],
    );
    expect(ok).toBe(true);
  });

  it("returns false when eth_call simulation reverts", async () => {
    const signer = {
      readContract: vi.fn().mockRejectedValue(new Error("revert")),
    } as FacilitatorEvmSigner;
    const ok = await simulatePermit2Settle(
      { proxyAddress: "0x1111111111111111111111111111111111111111", proxyABI: [] },
      signer,
      [],
    );
    expect(ok).toBe(false);
  });
});

describe("validateEip2612PermitForPayment", () => {
  const future = String(Math.floor(Date.now() / 1000) + 3600);
  const sig = "aa".repeat(64) + "1b";
  const valid = {
    from: PAYER,
    asset: TOKEN,
    spender: PERMIT2_ADDRESS,
    amount: "1000",
    nonce: "1",
    deadline: future,
    signature: `0x${sig}`,
    version: "1",
  };

  it("rejects malformed extension info before checking payer binding", () => {
    const result = validateEip2612PermitForPayment(
      {
        from: "not-an-address",
        asset: TOKEN,
        spender: PERMIT2_ADDRESS,
        amount: "1",
        nonce: "1",
        deadline: "9999999999",
        signature: "0xab",
        version: "1",
      },
      PAYER,
      TOKEN,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_eip2612_extension_format");
  });

  it("rejects EIP-2612 permits that do not match the payer, token, or Permit2 spender", () => {
    expect(validateEip2612PermitForPayment({ ...valid, from: zeroAddress }, PAYER, TOKEN)).toEqual({
      isValid: false,
      invalidReason: "eip2612_from_mismatch",
    });
    expect(
      validateEip2612PermitForPayment(
        { ...valid, asset: "0x0000000000000000000000000000000000000001" },
        PAYER,
        TOKEN,
      ).invalidReason,
    ).toBe("eip2612_asset_mismatch");
    expect(
      validateEip2612PermitForPayment(
        { ...valid, spender: "0x0000000000000000000000000000000000000002" },
        PAYER,
        TOKEN,
      ).invalidReason,
    ).toBe("eip2612_spender_not_permit2");
    expect(
      validateEip2612PermitForPayment({ ...valid, deadline: "1" }, PAYER, TOKEN).invalidReason,
    ).toBe("eip2612_deadline_expired");
  });
});
