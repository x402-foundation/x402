import { describe, it, expect } from "vitest";
import { BaseError, ContractFunctionRevertedError } from "viem";
import {
  collectPayer,
  decodeRevertReason,
  facilitatorAddresses,
  resolveSubmitter,
  selectSubmitter,
} from "../../../src/auth-capture/facilitator/utils";
import {
  ESCROW_ERROR_TO_INVALID_REASON,
  ErrSimulationFailed,
} from "../../../src/auth-capture/errors";
import { EIP3009_TOKEN_COLLECTOR_ADDRESS } from "../../../src/auth-capture/constants";
import type { FacilitatorEvmSigner } from "../../../src/signer";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const C = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;

function signer(addresses: readonly `0x${string}`[]): FacilitatorEvmSigner {
  return { getAddresses: () => [...addresses] } as FacilitatorEvmSigner;
}

describe("auth-capture facilitator utils", () => {
  it("deduplicates facilitator submitter addresses across signers", () => {
    expect(facilitatorAddresses([signer([A]), signer([A, B])])).toEqual([A, B]);
  });

  it("selects the signer that owns a delegated captureAuthorizer", () => {
    const signers = [signer([A]), signer([B])];
    expect(selectSubmitter(signers, B)?.getAddresses()).toEqual([B]);
    expect(selectSubmitter(signers, C)).toBeUndefined();
  });

  it("uses the first signer for custom operators", () => {
    const signers = [signer([A]), signer([B])];
    expect(resolveSubmitter(signers, { operatorType: "custom", captureAuthorizer: C })).toBe(
      signers[0],
    );
    expect(resolveSubmitter(signers, { operatorType: "delegated", captureAuthorizer: B })).toBe(
      signers[1],
    );
  });

  it("reads the payer from EIP-3009 and Permit2 collect envelopes", () => {
    expect(
      collectPayer({
        authorization: {
          from: A,
          to: EIP3009_TOKEN_COLLECTOR_ADDRESS,
          value: "1",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: "0x" + "11".repeat(32),
        },
        signature: "0xab",
        salt: "0x" + "22".repeat(32),
      }),
    ).toBe(A);
    expect(
      collectPayer({
        permit2Authorization: {
          from: B,
          permitted: { token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "1" },
          spender: EIP3009_TOKEN_COLLECTOR_ADDRESS,
          nonce: "1",
          deadline: "9999999999",
        },
        signature: "0xab",
        salt: "0x" + "22".repeat(32),
      }),
    ).toBe(B);
  });

  it("maps escrow custom errors to stable wire reasons", () => {
    for (const [errorName, reason] of Object.entries(ESCROW_ERROR_TO_INVALID_REASON)) {
      const revert = new ContractFunctionRevertedError({
        abi: [],
        data: "0x",
        functionName: "authorize",
        sender: A,
      });
      Object.defineProperty(revert, "data", { value: { errorName } });
      const wrapped = new BaseError("reverted", { cause: revert });
      expect(decodeRevertReason(wrapped)).toBe(reason);
    }
    expect(decodeRevertReason(new Error("boom"))).toBe(ErrSimulationFailed);
  });
});
