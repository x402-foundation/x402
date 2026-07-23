import { describe, it, expect } from "vitest";
import { parseEip3009TransferError } from "../../../src/exact/facilitator/eip3009-utils";
import * as Errors from "../../../src/exact/facilitator/errors";

describe("parseEip3009TransferError", () => {
  describe("relayer gas exhaustion", () => {
    const messages: ReadonlyArray<[string, string]> = [
      ["go-ethereum style", "insufficient funds for gas * price + value"],
      ["geth alternate", "err: insufficient funds for transfer: address 0x..."],
      [
        "account balance phrasing",
        "sender doesn't have enough funds to send tx. The max upfront cost is: 100000000000000000 and the sender's account only has: 10000000000000000 — exceeds the balance of the account",
      ],
      ["nethermind", "insufficient balance for transaction"],
      [
        "viem viem",
        "Error: insufficient funds for gas * price + value: address 0xabc want 100 have 1",
      ],
    ];

    for (const [label, msg] of messages) {
      it(`classifies "${label}" as ErrRelayerInsufficientFunds`, () => {
        expect(parseEip3009TransferError(new Error(msg))).toBe(Errors.ErrRelayerInsufficientFunds);
      });
    }
  });

  describe("EIP-3009 contract reverts", () => {
    it("AuthorizationExpired -> ErrValidBeforeExpired", () => {
      expect(parseEip3009TransferError(new Error("FiatTokenV2: authorization is expired"))).toBe(
        Errors.ErrValidBeforeExpired,
      );
      expect(parseEip3009TransferError(new Error("AuthorizationExpired()"))).toBe(
        Errors.ErrValidBeforeExpired,
      );
    });

    it("AuthorizationNotYetValid -> ErrValidAfterInFuture", () => {
      expect(parseEip3009TransferError(new Error("authorization is not yet valid"))).toBe(
        Errors.ErrValidAfterInFuture,
      );
      expect(parseEip3009TransferError(new Error("AuthorizationNotYetValid()"))).toBe(
        Errors.ErrValidAfterInFuture,
      );
    });

    it("AuthorizationAlreadyUsed -> ErrEip3009NonceAlreadyUsed", () => {
      expect(parseEip3009TransferError(new Error("FiatTokenV2: authorization is used"))).toBe(
        Errors.ErrEip3009NonceAlreadyUsed,
      );
      expect(parseEip3009TransferError(new Error("AuthorizationAlreadyUsed()"))).toBe(
        Errors.ErrEip3009NonceAlreadyUsed,
      );
      expect(parseEip3009TransferError(new Error("AuthorizationUsedOrCanceled()"))).toBe(
        Errors.ErrEip3009NonceAlreadyUsed,
      );
    });

    it("payer ERC-20 balance shortfall -> ErrEip3009InsufficientBalance", () => {
      expect(parseEip3009TransferError(new Error("ERC20: transfer amount exceeds balance"))).toBe(
        Errors.ErrEip3009InsufficientBalance,
      );
      expect(
        parseEip3009TransferError(new Error("ERC20InsufficientBalance(0x..., 100, 200)")),
      ).toBe(Errors.ErrEip3009InsufficientBalance);
    });

    it("signature reverts -> ErrInvalidSignature", () => {
      expect(parseEip3009TransferError(new Error("FiatTokenV2: invalid signature"))).toBe(
        Errors.ErrInvalidSignature,
      );
      expect(parseEip3009TransferError(new Error("SignerMismatch()"))).toBe(
        Errors.ErrInvalidSignature,
      );
      expect(parseEip3009TransferError(new Error("InvalidSignatureV()"))).toBe(
        Errors.ErrInvalidSignature,
      );
      expect(parseEip3009TransferError(new Error("InvalidSignatureS()"))).toBe(
        Errors.ErrInvalidSignature,
      );
    });
  });

  describe("regressions across buckets", () => {
    it("payer ERC-20 balance error is NOT classified as relayer gas exhaustion", () => {
      expect(parseEip3009TransferError(new Error("ERC20: transfer amount exceeds balance"))).toBe(
        Errors.ErrEip3009InsufficientBalance,
      );
    });

    it("relayer gas exhaustion is NOT classified as payer ERC-20 balance error", () => {
      expect(
        parseEip3009TransferError(new Error("insufficient funds for gas * price + value")),
      ).toBe(Errors.ErrRelayerInsufficientFunds);
    });

    it("unknown reverts still fall back to ErrTransactionFailed", () => {
      expect(parseEip3009TransferError(new Error("something nobody has ever seen"))).toBe(
        Errors.ErrTransactionFailed,
      );
    });

    it("non-Error values are handled", () => {
      expect(parseEip3009TransferError("authorization is expired")).toBe(
        Errors.ErrValidBeforeExpired,
      );
      expect(parseEip3009TransferError({ toString: () => "insufficient funds for gas" })).toBe(
        Errors.ErrRelayerInsufficientFunds,
      );
    });
  });
});
