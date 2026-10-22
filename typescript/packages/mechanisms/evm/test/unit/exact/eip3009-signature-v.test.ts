import { describe, it, expect, vi } from "vitest";
import {
  executeTransferWithAuthorization,
  simulateEip3009TransferResult,
} from "../../../src/exact/facilitator/eip3009-utils";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import type { ExactEIP3009Payload } from "../../../src/types";

const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const R = "ab".repeat(32);
const S = "cd".repeat(32);

function payload(vByte: string): ExactEIP3009Payload {
  return {
    signature: `0x${R}${S}${vByte}`,
    authorization: {
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      value: "1000000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: `0x${"00".repeat(32)}`,
    },
  };
}

function signer(): FacilitatorEvmSigner {
  return {
    readContract: vi.fn().mockResolvedValue(undefined),
    writeContract: vi.fn().mockResolvedValue("0xhash"),
  } as unknown as FacilitatorEvmSigner;
}

// FiatToken and similar contracts only accept v = 27 or 28.
describe("transferWithAuthorization v value", () => {
  it.each([
    ["1b", 27],
    ["1c", 28],
    ["00", 27],
    ["01", 28],
  ])("passes v=%s as %i when simulating and settling", async (vByte, expected) => {
    const s = signer();
    await simulateEip3009TransferResult(s, TOKEN, payload(vByte));
    await executeTransferWithAuthorization(s, TOKEN, payload(vByte));

    const readArgs = (s.readContract as ReturnType<typeof vi.fn>).mock.calls[0][0].args;
    const writeArgs = (s.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0].args;
    expect(Number(readArgs[6])).toBe(expected);
    expect(Number(writeArgs[6])).toBe(expected);
  });
});
