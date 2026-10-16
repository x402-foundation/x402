import { describe, it, expect, vi } from "vitest";
import {
  executeTransferWithAuthorization,
  simulateEip3009Transfer,
} from "../../../src/exact/facilitator/eip3009-utils";
import { splitEip2612Signature } from "../../../src/shared/permit2";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import type { ExactEIP3009Payload } from "../../../src/types";

const R = "11".repeat(32);
const S = "22".repeat(32);
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const payloadWithV = (vByte: string): ExactEIP3009Payload => ({
  signature: `0x${R}${S}${vByte}`,
  authorization: {
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    value: "1000",
    validAfter: "0",
    validBefore: "9999999999",
    nonce: `0x${"33".repeat(32)}`,
  },
});

// Some signers (e.g. KMS/HSM backends) return the recovery byte as the raw y-parity (0/1).
// ecrecover-based tokens such as USDC only accept 27/28, so the facilitator must normalize it.
const cases = [
  ["00", 27],
  ["01", 28],
  ["1b", 27],
  ["1c", 28],
] as const;

describe("ECDSA recovery byte normalization", () => {
  it.each(cases)("executeTransferWithAuthorization sends v=%s as %i", async (vByte, expected) => {
    const writeContract = vi.fn().mockResolvedValue("0xhash");
    const signer = { writeContract } as unknown as FacilitatorEvmSigner;

    await executeTransferWithAuthorization(signer, USDC, payloadWithV(vByte));

    const args = writeContract.mock.calls[0][0].args;
    expect(Number(args[6])).toBe(expected);
    expect(args[7]).toBe(`0x${R}`);
    expect(args[8]).toBe(`0x${S}`);
  });

  it.each(cases)("simulateEip3009Transfer simulates v=%s as %i", async (vByte, expected) => {
    const readContract = vi.fn().mockResolvedValue(undefined);
    const signer = { readContract } as unknown as FacilitatorEvmSigner;

    await simulateEip3009Transfer(signer, USDC, payloadWithV(vByte));

    expect(Number(readContract.mock.calls[0][0].args[6])).toBe(expected);
  });

  it.each(cases)("splitEip2612Signature returns v=%s as %i", (vByte, expected) => {
    expect(splitEip2612Signature(`0x${R}${S}${vByte}`)).toEqual({
      v: expected,
      r: `0x${R}`,
      s: `0x${S}`,
    });
  });
});
