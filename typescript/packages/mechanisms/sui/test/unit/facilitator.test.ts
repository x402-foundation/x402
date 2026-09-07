import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExactSuiScheme } from "../../src/exact/facilitator/scheme";
import { SUI_MAINNET_CAIP2, SUI_TESTNET_CAIP2, USDC_TESTNET } from "../../src/constants";
import {
  buildTestTransaction,
  exactBalanceChanges,
  failureRecord,
  mockClient,
  payer,
  payTo,
  signOnly,
  signPayload,
  successRecord,
  testPayload,
  testRequirements,
} from "./helpers";

describe("ExactSuiScheme facilitator", () => {
  let mock: ReturnType<typeof mockClient>;
  let scheme: ExactSuiScheme;

  beforeEach(() => {
    mock = mockClient();
    scheme = new ExactSuiScheme({ clients: { [SUI_TESTNET_CAIP2]: mock.client } });
  });

  /**
   * A verified-clean payload whose simulation returns the exact transfer.
   *
   * @returns The payment payload envelope
   */
  async function validPayload() {
    const payload = await signPayload(await buildTestTransaction());
    mock.core.simulateTransaction.mockResolvedValue({
      $kind: "Transaction",
      Transaction: successRecord(exactBalanceChanges()),
    });
    return testPayload(payload);
  }

  /**
   * Mock a settled transaction: submission acks, and waitForTransaction returns
   * the finalized record — balance changes are read from the wait, not submission.
   *
   * @param record - The finalized transaction record
   */
  function settled(record: ReturnType<typeof successRecord>) {
    const result = { $kind: "Transaction" as const, Transaction: record };
    mock.core.executeTransaction.mockResolvedValue(result);
    mock.core.waitForTransaction.mockResolvedValue(result);
  }

  describe("verify", () => {
    it("accepts a valid payment and reports the sender as payer", async () => {
      const result = await scheme.verify(await validPayload(), testRequirements());
      expect(result).toEqual({ isValid: true, invalidReason: undefined, payer });
    });

    it("accepts effects-only: an unexpected command shape still verifies if effects match", async () => {
      // buildTestTransaction uses transferObjects — a command the client never
      // emits — proving verification does not gate on command shape.
      const result = await scheme.verify(await validPayload(), testRequirements());
      expect(result.isValid).toBe(true);
    });

    it("rejects a wrong x402 version", async () => {
      const payload = { ...(await validPayload()), x402Version: 1 };
      expect((await scheme.verify(payload, testRequirements())).invalidReason).toBe(
        "invalid_x402_version",
      );
    });

    it("rejects a non-exact scheme", async () => {
      const result = await scheme.verify(
        await validPayload(),
        testRequirements({ scheme: "upto" }),
      );
      expect(result.invalidReason).toBe("unsupported_scheme");
    });

    it("rejects a network mismatch", async () => {
      const result = await scheme.verify(
        await validPayload(),
        testRequirements({ network: SUI_MAINNET_CAIP2 }),
      );
      expect(result.invalidReason).toBe("network_mismatch");
    });

    it("rejects an unsupported network", async () => {
      const requirements = testRequirements({ network: "sui:unknown" });
      const payload = testPayload(await signPayload(await buildTestTransaction()), requirements);
      expect((await scheme.verify(payload, requirements)).invalidReason).toBe("invalid_network");
    });

    it("rejects a malformed payload", async () => {
      const payload = testPayload({ transaction: "abc", signature: undefined as never });
      expect((await scheme.verify(payload, testRequirements())).invalidReason).toBe(
        "invalid_payload",
      );
    });

    it("rejects undecodable transaction bytes", async () => {
      const payload = testPayload({ transaction: "bm90IGEgdHg=", signature: "sig" });
      expect((await scheme.verify(payload, testRequirements())).invalidReason).toBe(
        "invalid_exact_sui_payload_transaction_could_not_be_decoded",
      );
    });

    it("rejects a signature that does not bind the sender", async () => {
      const payload = await signPayload(await buildTestTransaction(), new Ed25519Keypair());
      expect((await scheme.verify(testPayload(payload), testRequirements())).invalidReason).toBe(
        "invalid_exact_sui_payload_invalid_signature",
      );
    });

    it("accepts a signature ARRAY where one entry binds the sender", async () => {
      // A multi-signer transaction (e.g. a sponsor distinct from the sender): the
      // array carries a non-binding entry first, then the sender's signature.
      const transaction = await buildTestTransaction();
      const senderSig = await signOnly(transaction);
      const otherSig = await signOnly(transaction, new Ed25519Keypair());
      mock.core.simulateTransaction.mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord(exactBalanceChanges()),
      });
      const payload = testPayload({ transaction, signature: [otherSig, senderSig] });
      const result = await scheme.verify(payload, testRequirements());
      expect(result).toEqual({ isValid: true, invalidReason: undefined, payer });
    });

    it("rejects a signature ARRAY where none binds the sender", async () => {
      const transaction = await buildTestTransaction();
      const otherSigA = await signOnly(transaction, new Ed25519Keypair());
      const otherSigB = await signOnly(transaction, new Ed25519Keypair());
      const payload = testPayload({ transaction, signature: [otherSigA, otherSigB] });
      expect((await scheme.verify(payload, testRequirements())).invalidReason).toBe(
        "invalid_exact_sui_payload_invalid_signature",
      );
    });

    // 16 bytes of 0xab / 0xcd, Base64.
    const NONCE = "q6urq6urq6urq6urq6urqw==";
    const OTHER_NONCE = "zc3Nzc3Nzc3Nzc3Nzc3NzQ==";

    it("accepts a declared nonce carried as an unused Pure input", async () => {
      const payload = await signPayload(await buildTestTransaction({ nonce: NONCE }));
      mock.core.simulateTransaction.mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord(exactBalanceChanges()),
      });
      const result = await scheme.verify(
        testPayload(payload),
        testRequirements({ extra: { nonce: NONCE } }),
      );
      expect(result.isValid).toBe(true);
    });

    it("accepts a declared nonce carried as a USED Pure input (referenced by a command)", async () => {
      const payload = await signPayload(
        await buildTestTransaction({ nonce: NONCE, nonceUsed: true }),
      );
      mock.core.simulateTransaction.mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord(exactBalanceChanges()),
      });
      const result = await scheme.verify(
        testPayload(payload),
        testRequirements({ extra: { nonce: NONCE } }),
      );
      expect(result.isValid).toBe(true);
    });

    it("accepts a declared nonce LONGER than 32 bytes (no size cap)", async () => {
      // 40 bytes of 0xab, Base64 — beyond the 32-byte gasless recommendation.
      const bigNonce = "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urqw==";
      const payload = await signPayload(await buildTestTransaction({ nonce: bigNonce }));
      mock.core.simulateTransaction.mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord(exactBalanceChanges()),
      });
      const result = await scheme.verify(
        testPayload(payload),
        testRequirements({ extra: { nonce: bigNonce } }),
      );
      expect(result.isValid).toBe(true);
    });

    it("accepts when no nonce is declared and none is carried", async () => {
      const payload = await signPayload(await buildTestTransaction());
      mock.core.simulateTransaction.mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord(exactBalanceChanges()),
      });
      const result = await scheme.verify(testPayload(payload), testRequirements());
      expect(result.isValid).toBe(true);
    });

    it("rejects when a declared nonce is not carried", async () => {
      const payload = await signPayload(await buildTestTransaction({ nonce: NONCE }));
      const result = await scheme.verify(
        testPayload(payload),
        testRequirements({ extra: { nonce: OTHER_NONCE } }),
      );
      expect(result.invalidReason).toBe("invalid_exact_sui_payload_missing_nonce");
    });

    it("rejects when a declared nonce is absent from the transaction", async () => {
      const payload = await signPayload(await buildTestTransaction());
      const result = await scheme.verify(
        testPayload(payload),
        testRequirements({ extra: { nonce: OTHER_NONCE } }),
      );
      expect(result.invalidReason).toBe("invalid_exact_sui_payload_missing_nonce");
    });

    it("rejects a malformed (invalid Base64) declared nonce", async () => {
      const payload = await signPayload(await buildTestTransaction());
      const result = await scheme.verify(
        testPayload(payload),
        testRequirements({ extra: { nonce: "!!!not base64!!!" } }),
      );
      expect(result.invalidReason).toBe("invalid_exact_sui_payload_missing_nonce");
    });

    it("rejects an already-executed transaction", async () => {
      const payload = await validPayload();
      mock.core.getTransaction.mockResolvedValue({ $kind: "Transaction" });
      expect((await scheme.verify(payload, testRequirements())).invalidReason).toBe(
        "invalid_transaction_state",
      );
    });

    it("does not treat an unrelated not-found message as a missing transaction", async () => {
      const payload = await validPayload();
      mock.core.getTransaction.mockRejectedValue(new Error("proxy route not found"));
      const result = await scheme.verify(payload, testRequirements());
      expect(result.invalidReason).toBe("invalid_exact_sui_payload_verification_error");
      expect(mock.core.simulateTransaction).not.toHaveBeenCalled();
    });

    it("rejects a failed simulation", async () => {
      const payload = await signPayload(await buildTestTransaction());
      mock.core.simulateTransaction.mockResolvedValue({
        $kind: "FailedTransaction",
        FailedTransaction: failureRecord("insufficient balance"),
      });
      expect((await scheme.verify(testPayload(payload), testRequirements())).invalidReason).toBe(
        "invalid_exact_sui_payload_simulation_failed",
      );
    });

    it("rejects underpayment and overpayment (exact means exact)", async () => {
      for (const amt of ["9999", "10001"]) {
        const payload = await signPayload(await buildTestTransaction());
        mock.core.simulateTransaction.mockResolvedValue({
          $kind: "Transaction",
          Transaction: successRecord(exactBalanceChanges(amt)),
        });
        const result = await scheme.verify(testPayload(payload), testRequirements());
        expect(result.invalidReason).toBe("invalid_exact_sui_payload_transfer_mismatch");
      }
    });

    it("is composable: verifies despite an undeclared credit and a non-(-amount) payer delta", async () => {
      // The declared recipient nets exactly its amount, but the transaction ALSO
      // credits an undeclared address and the payer does NOT net -amount (a
      // swap-sourced payment where the payer nets ~0). Recipient-credit-only
      // verification accepts this.
      const payload = await signPayload(await buildTestTransaction());
      mock.core.simulateTransaction.mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord([
          { coinType: USDC_TESTNET, address: payer, amount: "2000" }, // net inflow, not -amount
          { coinType: USDC_TESTNET, address: `0x${"44".repeat(32)}`, amount: "-12000" },
          { coinType: USDC_TESTNET, address: payTo, amount: "10000" },
          { coinType: USDC_TESTNET, address: `0x${"33".repeat(32)}`, amount: "1000" }, // undeclared
        ]),
      });
      expect((await scheme.verify(testPayload(payload), testRequirements())).isValid).toBe(true);
    });
  });

  describe("settle", () => {
    it("fails when validation fails, without executing", async () => {
      const payload = await signPayload(await buildTestTransaction(), new Ed25519Keypair());
      const result = await scheme.settle(testPayload(payload), testRequirements());
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("invalid_exact_sui_payload_invalid_signature");
      expect(mock.core.executeTransaction).not.toHaveBeenCalled();
    });

    it("succeeds on executed effects that contain the exact transfer", async () => {
      const payload = await validPayload();
      settled(successRecord(exactBalanceChanges(), "settled-digest"));
      const result = await scheme.settle(payload, testRequirements());
      expect(result).toMatchObject({ success: true, transaction: "settled-digest", payer });
    });

    it("passes a signature ARRAY through to executeTransaction", async () => {
      const transaction = await buildTestTransaction();
      const senderSig = await signOnly(transaction);
      const otherSig = await signOnly(transaction, new Ed25519Keypair());
      const signature = [senderSig, otherSig];
      settled(successRecord(exactBalanceChanges(), "multi-sig-digest"));
      const payload = testPayload({ transaction, signature });
      const result = await scheme.settle(payload, testRequirements());
      expect(result).toMatchObject({ success: true, transaction: "multi-sig-digest", payer });
      expect(mock.core.executeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ signatures: signature }),
      );
    });

    it("does not simulate during settle", async () => {
      const payload = await validPayload();
      mock.core.simulateTransaction.mockClear();
      settled(successRecord(exactBalanceChanges(), "d"));
      await scheme.settle(payload, testRequirements());
      expect(mock.core.simulateTransaction).not.toHaveBeenCalled();
    });

    it("fails when execution commits a failed transaction", async () => {
      const payload = await validPayload();
      mock.core.executeTransaction.mockResolvedValue({
        $kind: "FailedTransaction",
        FailedTransaction: failureRecord("abort"),
      });
      const result = await scheme.settle(payload, testRequirements());
      expect(result.errorReason).toBe("transaction_failed");
    });

    it("fails when executed effects do not match the requirements", async () => {
      const payload = await validPayload();
      settled(successRecord(exactBalanceChanges("9999"), "short"));
      const result = await scheme.settle(payload, testRequirements());
      expect(result.errorReason).toBe("settlement_effects_mismatch");
    });

    it("is idempotent: re-execution yields the same success", async () => {
      const payload = await validPayload();
      settled(successRecord(exactBalanceChanges(), "orig"));
      const first = await scheme.settle(payload, testRequirements());
      // fresh scheme to avoid the dedup guard rejecting the identical replay
      const scheme2 = new ExactSuiScheme({ clients: { [SUI_TESTNET_CAIP2]: mock.client } });
      const second = await scheme2.settle(payload, testRequirements());
      expect(first).toMatchObject({ success: true, transaction: "orig" });
      expect(second).toEqual(first);
    });

    it("rejects a concurrent duplicate via the settlement guard", async () => {
      const payload = await validPayload();
      settled(successRecord(exactBalanceChanges(), "orig"));
      const first = await scheme.settle(payload, testRequirements());
      const second = await scheme.settle(payload, testRequirements());
      expect(first.success).toBe(true);
      expect(second.errorReason).toBe("duplicate_settlement");
    });

    it("surfaces a genuine execution error as transaction_failed", async () => {
      const payload = await validPayload();
      mock.core.executeTransaction.mockRejectedValue(new Error("fullnode unavailable"));
      const result = await scheme.settle(payload, testRequirements());
      expect(result.errorReason).toBe("transaction_failed");
      expect(result.errorMessage).toBe("fullnode unavailable");
    });
  });

  describe("executor", () => {
    const feePayer = new Ed25519Keypair().toSuiAddress();

    /**
     * Build a facilitator with a mock executor and matching sponsored requirements.
     *
     * @param result - The executor's result
     * @returns The scheme, the executor mock, and sponsored requirements
     */
    function withExecutor(result: unknown) {
      const executeTransaction = vi.fn().mockResolvedValue(result);
      const s = new ExactSuiScheme({
        clients: { [SUI_TESTNET_CAIP2]: mock.client },
        executeTransaction,
        feePayer,
      });
      const requirements = testRequirements({ extra: { feePayer } });
      return { s, executeTransaction, requirements };
    }

    it("advertises the fee-payer via getExtra / getSigners", () => {
      const { s } = withExecutor(null);
      expect(s.getExtra(SUI_TESTNET_CAIP2)).toEqual({ feePayer });
      expect(s.getSigners(SUI_TESTNET_CAIP2)).toEqual([feePayer]);
    });

    it("advertises nothing without a fee-payer", () => {
      expect(scheme.getExtra(SUI_TESTNET_CAIP2)).toBeUndefined();
      expect(scheme.getSigners(SUI_TESTNET_CAIP2)).toEqual([]);
    });

    it("settles by delegating to the executor", async () => {
      const { s, executeTransaction, requirements } = withExecutor({
        $kind: "Transaction",
        Transaction: successRecord(exactBalanceChanges(), "executor-digest"),
      });
      mock.core.waitForTransaction.mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord(exactBalanceChanges(), "executor-digest"),
      });
      const payload = testPayload(await signPayload(await buildTestTransaction()), requirements);
      const result = await s.settle(payload, requirements);
      expect(result).toMatchObject({ success: true, transaction: "executor-digest" });
      expect(executeTransaction).toHaveBeenCalledOnce();
      expect(mock.core.executeTransaction).not.toHaveBeenCalled();
    });

    it("fails when the executor rejects by policy", async () => {
      const { s, requirements } = withExecutor({
        $kind: "Rejected",
        reason: "package not allowed",
      });
      const payload = testPayload(await signPayload(await buildTestTransaction()), requirements);
      const result = await s.settle(payload, requirements);
      expect(result.errorReason).toBe("sponsor_rejected");
      expect(result.errorMessage).toBe("package not allowed");
    });

    it("fails when the executor's transaction aborts on-chain", async () => {
      const { s, requirements } = withExecutor({
        $kind: "FailedTransaction",
        FailedTransaction: failureRecord("abort in move call"),
      });
      const payload = testPayload(await signPayload(await buildTestTransaction()), requirements);
      const result = await s.settle(payload, requirements);
      expect(result.errorReason).toBe("transaction_failed");
    });
  });
});
