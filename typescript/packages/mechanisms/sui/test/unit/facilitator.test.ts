import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { MultiSigPublicKey } from "@mysten/sui/multisig";
import { getZkLoginSignature, toZkLoginPublicIdentifier } from "@mysten/sui/zklogin";
import { Transaction } from "@mysten/sui/transactions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExactSuiScheme } from "../../src/exact/facilitator/scheme";
import { SUI_MAINNET_CAIP2, SUI_TESTNET_CAIP2, USDC_TESTNET } from "../../src/constants";
import { SettlementCache } from "../../src/settlement-cache";
import type { SettlementGuard } from "../../src/types";
import {
  buildTestTransaction,
  digestOf,
  EPOCH,
  exactBalanceChanges,
  failureRecord,
  feePayer,
  mockClient,
  payer,
  payTo,
  signOnly,
  sponsorKeypair,
  signPayload,
  successRecord,
  testPayload,
  testRequirements,
  validDuring,
  type TestTransactionOptions,
} from "./helpers";

const NONCE = "q6urq6urq6urq6urq6urqw==";

/**
 * An executor result for the submitted bytes, as a real executor reports it.
 *
 * @param input - The executor input
 * @param input.transaction - The submitted transaction bytes
 * @returns A successful transaction carrying the bytes' digest
 */
async function executed({ transaction }: { transaction: Uint8Array }) {
  const digest = await Transaction.from(transaction).getDigest();
  return { $kind: "Transaction", Transaction: successRecord(exactBalanceChanges(), digest) };
}
const OTHER_NONCE = "zc3Nzc3Nzc3Nzc3Nzc3NzQ==";

describe("ExactSuiScheme facilitator", () => {
  let mock: ReturnType<typeof mockClient>;
  let scheme: ExactSuiScheme;

  beforeEach(() => {
    mock = mockClient();
    scheme = new ExactSuiScheme({ clients: { [SUI_TESTNET_CAIP2]: mock.client } });
    mock.core.simulateTransaction.mockResolvedValue({
      $kind: "Transaction",
      Transaction: successRecord(exactBalanceChanges()),
    });
  });

  /**
   * A signed payment envelope.
   *
   * @param options - Transaction options
   * @param requirements - The accepted requirements
   * @returns The payment payload envelope
   */
  async function payment(options?: TestTransactionOptions, requirements = testRequirements()) {
    return testPayload(await signPayload(await buildTestTransaction(options)), requirements);
  }

  /**
   * Mock a settled transaction: submission acks and the finality wait returns
   * the record.
   *
   * @param record - The finalized transaction record
   */
  function settled(record: ReturnType<typeof successRecord>) {
    const result = { $kind: "Transaction" as const, Transaction: record };
    mock.core.executeTransaction.mockResolvedValue(result);
    mock.core.waitForTransaction.mockResolvedValue(result);
  }

  describe("verify", () => {
    it("accepts a self-paid address-balance payment", async () => {
      const result = await scheme.verify(await payment(), testRequirements());
      expect(result).toEqual({ isValid: true, invalidReason: undefined, payer });
    });

    it("accepts a self-paid payment with gas coins", async () => {
      const result = await scheme.verify(await payment({ gasCoins: 1 }), testRequirements());
      expect(result.isValid).toBe(true);
    });

    it("rejects a wrong x402 version", async () => {
      const payload = { ...(await payment()), x402Version: 1 };
      expect((await scheme.verify(payload, testRequirements())).invalidReason).toBe(
        "invalid_x402_version",
      );
    });

    it("rejects a non-exact scheme", async () => {
      const result = await scheme.verify(await payment(), testRequirements({ scheme: "upto" }));
      expect(result.invalidReason).toBe("unsupported_scheme");
    });

    it("rejects a network mismatch", async () => {
      const result = await scheme.verify(
        await payment(),
        testRequirements({ network: SUI_MAINNET_CAIP2 }),
      );
      expect(result.invalidReason).toBe("network_mismatch");
    });

    it("rejects an unsupported network", async () => {
      const requirements = testRequirements({ network: "sui:unknown" });
      const payload = await payment({}, requirements);
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

    it("rejects a signature beyond the required signers", async () => {
      const transaction = await buildTestTransaction();
      const signature = [
        await signOnly(transaction, new Ed25519Keypair()),
        await signOnly(transaction),
      ];
      const result = await scheme.verify(
        testPayload({ transaction, signature }),
        testRequirements(),
      );
      expect(result.invalidReason).toBe("invalid_exact_sui_payload_invalid_signature");
    });

    it("requires the signature of a gas owner other than the sender", async () => {
      const owner = new Ed25519Keypair();
      const transaction = await buildTestTransaction({ gasOwner: owner.toSuiAddress() });
      const senderOnly = testPayload({ transaction, signature: await signOnly(transaction) });
      expect((await scheme.verify(senderOnly, testRequirements())).invalidReason).toBe(
        "invalid_exact_sui_payload_invalid_signature",
      );
      const both = testPayload({
        transaction,
        signature: [await signOnly(transaction, owner), await signOnly(transaction)],
      });
      expect(await scheme.verify(both, testRequirements())).toEqual({
        isValid: true,
        invalidReason: undefined,
        payer,
      });
    });

    it("rejects the same signature given twice for two signers", async () => {
      const owner = new Ed25519Keypair();
      const transaction = await buildTestTransaction({ gasOwner: owner.toSuiAddress() });
      const sig = await signOnly(transaction);
      const result = await scheme.verify(
        testPayload({ transaction, signature: [sig, sig] }),
        testRequirements(),
      );
      expect(result.invalidReason).toBe("invalid_exact_sui_payload_invalid_signature");
    });

    it("rejects a signature array where none binds the sender", async () => {
      const transaction = await buildTestTransaction();
      const signature = [
        await signOnly(transaction, new Ed25519Keypair()),
        await signOnly(transaction, new Ed25519Keypair()),
      ];
      expect(
        (await scheme.verify(testPayload({ transaction, signature }), testRequirements()))
          .invalidReason,
      ).toBe("invalid_exact_sui_payload_invalid_signature");
    });

    describe("expiration", () => {
      it.each([
        ["no expiration", { None: true as const }],
        ["an Epoch expiration", { Epoch: EPOCH + 1 }],
        ["a span of two epochs", validDuring(EPOCH, EPOCH + 2)],
        ["maxEpoch before minEpoch", validDuring(EPOCH + 1, EPOCH)],
        ["an unset maxEpoch", validDuring(EPOCH, null)],
        ["an unset minEpoch", validDuring(null, EPOCH)],
      ])("rejects %s", async (_, expiration) => {
        const result = await scheme.verify(await payment({ expiration }), testRequirements());
        expect(result.invalidReason).toBe("invalid_exact_sui_payload_invalid_expiration");
        expect(mock.core.simulateTransaction).not.toHaveBeenCalled();
      });

      it("accepts a Validity expiration", async () => {
        const result = await scheme.verify(
          await payment({
            expiration: {
              Validity: {
                ...(validDuring() as { ValidDuring: Record<string, unknown> }).ValidDuring,
                allowedProposers: null,
              },
            },
          }),
          testRequirements(),
        );
        expect(result.isValid).toBe(true);
      });

      it("accepts a single-epoch window", async () => {
        const result = await scheme.verify(
          await payment({ expiration: validDuring(EPOCH, EPOCH) }),
          testRequirements(),
        );
        expect(result.isValid).toBe(true);
      });

      it("reports an expired window through simulation", async () => {
        mock.core.simulateTransaction.mockResolvedValue({
          $kind: "FailedTransaction",
          FailedTransaction: failureRecord("TransactionExpired"),
        });
        const result = await scheme.verify(
          await payment({ expiration: validDuring(1, 2) }),
          testRequirements(),
        );
        expect(result.invalidReason).toBe("invalid_exact_sui_payload_simulation_failed");
      });
    });

    describe("sponsorship baseline", () => {
      let sponsored: ExactSuiScheme;
      const requirements = testRequirements({ extra: { feePayer } });

      beforeEach(() => {
        sponsored = new ExactSuiScheme({
          clients: { [SUI_TESTNET_CAIP2]: mock.client },
          feePayer,
          executeTransaction: vi.fn(),
        });
      });

      it("accepts a sponsored payment with an empty gas payment", async () => {
        const result = await sponsored.verify(
          await payment({ sponsored: true }, requirements),
          requirements,
        );
        expect(result).toEqual({ isValid: true, invalidReason: undefined, payer });
      });

      it.each<[string, TestTransactionOptions]>([
        ["a non-empty gas payment", { sponsored: true, gasCoins: 1 }],
        ["a budget over the cap", { sponsored: true, gasBudget: 10_000_001 }],
        ["use of the gas coin", { sponsored: true, useGasCoin: true }],
        ["a withdrawal from the sponsor", { sponsored: true, withdrawFrom: "sponsor" }],
        [
          "a withdrawal under an allowance the sponsor funds",
          { sponsored: true, withdrawFrom: "sponsor-allowance" },
        ],
      ])("rejects %s", async (_, options) => {
        const result = await sponsored.verify(await payment(options, requirements), requirements);
        expect(result.invalidReason).toBe("invalid_exact_sui_payload_sponsorship_rejected");
        expect(mock.core.simulateTransaction).not.toHaveBeenCalled();
      });

      it("rejects a sponsored payload that already carries the sponsor's signature", async () => {
        const transaction = await buildTestTransaction({ sponsored: true });
        const payload = testPayload(
          {
            transaction,
            signature: [await signOnly(transaction), await signOnly(transaction, sponsorKeypair)],
          },
          requirements,
        );
        expect((await sponsored.verify(payload, requirements)).invalidReason).toBe(
          "invalid_exact_sui_payload_invalid_signature",
        );
      });

      it("applies even when the requirements omit feePayer", async () => {
        const result = await sponsored.verify(
          await payment({ sponsored: true, useGasCoin: true }),
          testRequirements(),
        );
        expect(result.invalidReason).toBe("invalid_exact_sui_payload_sponsorship_rejected");
      });

      it("allows a sender withdrawal on a sponsored payment", async () => {
        const result = await sponsored.verify(
          await payment({ sponsored: true, withdrawFrom: "sender" }, requirements),
          requirements,
        );
        expect(result.isValid).toBe(true);
      });

      it("applies a configured budget cap", async () => {
        const strict = new ExactSuiScheme({
          clients: { [SUI_TESTNET_CAIP2]: mock.client },
          feePayer,
          executeTransaction: vi.fn(),
          maxSponsoredGasBudget: 1_000_000n,
        });
        const result = await strict.verify(
          await payment({ sponsored: true, gasBudget: 2_000_000 }, requirements),
          requirements,
        );
        expect(result.invalidReason).toBe("invalid_exact_sui_payload_sponsorship_rejected");
      });

      it("does not apply to a self-paid payment", async () => {
        const result = await sponsored.verify(
          await payment({ useGasCoin: true, gasCoins: 1, gasBudget: 50_000_000 }),
          testRequirements(),
        );
        expect(result.isValid).toBe(true);
      });

      it("does not apply when the sender is the fee payer", async () => {
        const sponsorAsSender = new ExactSuiScheme({
          clients: { [SUI_TESTNET_CAIP2]: mock.client },
          feePayer: payer,
          executeTransaction: vi.fn(),
        });
        const result = await sponsorAsSender.verify(
          await payment({ gasOwner: payer, useGasCoin: true, gasCoins: 1 }),
          testRequirements(),
        );
        expect(result.isValid).toBe(true);
      });
    });

    it("accepts a declared nonce carried as an unused Pure input", async () => {
      const requirements = testRequirements({ extra: { nonce: NONCE } });
      const result = await scheme.verify(
        await payment({ nonce: NONCE }, requirements),
        requirements,
      );
      expect(result.isValid).toBe(true);
    });

    it("accepts a declared nonce used by a command", async () => {
      const requirements = testRequirements({ extra: { nonce: NONCE } });
      const result = await scheme.verify(
        await payment({ nonce: NONCE, nonceUsed: true }, requirements),
        requirements,
      );
      expect(result.isValid).toBe(true);
    });

    it("accepts a declared nonce longer than 32 bytes", async () => {
      const bigNonce = "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urqw==";
      const requirements = testRequirements({ extra: { nonce: bigNonce } });
      const result = await scheme.verify(
        await payment({ nonce: bigNonce }, requirements),
        requirements,
      );
      expect(result.isValid).toBe(true);
    });

    it("rejects a declared nonce the transaction does not carry", async () => {
      const requirements = testRequirements({ extra: { nonce: OTHER_NONCE } });
      for (const options of [{ nonce: NONCE }, {}]) {
        const result = await scheme.verify(await payment(options, requirements), requirements);
        expect(result.invalidReason).toBe("invalid_exact_sui_payload_missing_nonce");
      }
    });

    it("rejects a malformed declared nonce", async () => {
      const requirements = testRequirements({ extra: { nonce: "!!!not base64!!!" } });
      const result = await scheme.verify(await payment({}, requirements), requirements);
      expect(result.invalidReason).toBe("invalid_exact_sui_payload_missing_nonce");
    });

    it("rejects an already-executed transaction", async () => {
      mock.core.getTransaction.mockResolvedValue({ $kind: "Transaction" });
      expect((await scheme.verify(await payment(), testRequirements())).invalidReason).toBe(
        "invalid_exact_sui_payload_already_executed",
      );
    });

    it("does not treat a not-found message as a missing transaction", async () => {
      mock.core.getTransaction.mockRejectedValue(new Error("Transaction abc not found"));
      const result = await scheme.verify(await payment(), testRequirements());
      expect(result.invalidReason).toBe("invalid_exact_sui_payload_verification_error");
      expect(mock.core.simulateTransaction).not.toHaveBeenCalled();
    });

    it("simulates the signed bytes without gas selection", async () => {
      const payload = await payment();
      await scheme.verify(payload, testRequirements());
      expect(mock.core.simulateTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ doGasSelection: false, include: { balanceChanges: true } }),
      );
    });

    it("rejects a failed simulation", async () => {
      mock.core.simulateTransaction.mockResolvedValue({
        $kind: "FailedTransaction",
        FailedTransaction: failureRecord("insufficient balance"),
      });
      expect((await scheme.verify(await payment(), testRequirements())).invalidReason).toBe(
        "invalid_exact_sui_payload_simulation_failed",
      );
    });

    it("rejects underpayment and overpayment", async () => {
      for (const amount of ["9999", "10001"]) {
        mock.core.simulateTransaction.mockResolvedValue({
          $kind: "Transaction",
          Transaction: successRecord(exactBalanceChanges(amount)),
        });
        const result = await scheme.verify(await payment(), testRequirements());
        expect(result.invalidReason).toBe("invalid_exact_sui_payload_transfer_mismatch");
      }
    });

    it("checks only the recipient's credit", async () => {
      mock.core.simulateTransaction.mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord([
          { coinType: USDC_TESTNET, address: payer, amount: "2000" },
          { coinType: USDC_TESTNET, address: `0x${"44".repeat(32)}`, amount: "-12000" },
          { coinType: USDC_TESTNET, address: payTo, amount: "10000" },
        ]),
      });
      expect((await scheme.verify(await payment(), testRequirements())).isValid).toBe(true);
    });
  });

  describe("GraphQL transport", () => {
    /**
     * A facilitator over a real GraphQL client whose fetch returns `body`.
     *
     * @param body - The GraphQL response body
     * @returns The scheme and the client
     */
    function graphqlScheme(body: unknown) {
      const client = new SuiGraphQLClient({
        url: "https://graphql.invalid",
        network: "testnet",
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(body))) as never,
      });
      vi.spyOn(client.core, "simulateTransaction").mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord(exactBalanceChanges()),
      } as never);
      return new ExactSuiScheme({ clients: { [SUI_TESTNET_CAIP2]: client } });
    }

    it("treats a missing transaction as not executed", async () => {
      const s = graphqlScheme({ data: { transaction: null } });
      const result = await s.verify(await payment(), testRequirements());
      expect(result).toEqual({ isValid: true, invalidReason: undefined, payer });
    });

    it("does not treat a GraphQL error as not found", async () => {
      const s = graphqlScheme({ errors: [{ message: "Transaction not found" }] });
      const result = await s.verify(await payment(), testRequirements());
      expect(result.invalidReason).toBe("invalid_exact_sui_payload_verification_error");
    });
  });

  describe("settle", () => {
    it("fails validation without claiming or executing", async () => {
      const payload = await signPayload(await buildTestTransaction(), new Ed25519Keypair());
      const result = await scheme.settle(testPayload(payload), testRequirements());
      expect(result.errorReason).toBe("invalid_exact_sui_payload_invalid_signature");
      expect(mock.core.executeTransaction).not.toHaveBeenCalled();
    });

    it("rejects an invalid expiration", async () => {
      const result = await scheme.settle(
        await payment({ expiration: { None: true } }),
        testRequirements(),
      );
      expect(result.errorReason).toBe("invalid_exact_sui_payload_invalid_expiration");
      expect(mock.core.executeTransaction).not.toHaveBeenCalled();
    });

    it.each([
      ["before", EPOCH - 1],
      ["after", EPOCH + 2],
    ])("rejects when the current epoch is %s the window", async (_, epoch) => {
      mock.core.getCurrentSystemState.mockResolvedValue({ systemState: { epoch: String(epoch) } });
      const result = await scheme.settle(await payment(), testRequirements());
      expect(result.errorReason).toBe("invalid_exact_sui_payload_invalid_expiration");
      expect(mock.core.executeTransaction).not.toHaveBeenCalled();
    });

    it("re-fetches balance changes missing from the finalized transaction", async () => {
      const payload = await payment();
      const digest = await digestOf((payload.payload as { transaction: string }).transaction);
      const bare = { ...successRecord([], digest), balanceChanges: undefined };
      mock.core.executeTransaction.mockResolvedValue({ $kind: "Transaction", Transaction: bare });
      mock.core.waitForTransaction.mockResolvedValue({ $kind: "Transaction", Transaction: bare });
      mock.core.getTransaction.mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord(exactBalanceChanges(), digest),
      });
      expect(await scheme.settle(payload, testRequirements())).toMatchObject({
        success: true,
        transaction: digest,
      });
    });

    it("does not report a mismatch when balance changes stay unavailable", async () => {
      const bare = { ...successRecord([], "bare"), balanceChanges: undefined };
      mock.core.executeTransaction.mockResolvedValue({ $kind: "Transaction", Transaction: bare });
      mock.core.waitForTransaction.mockResolvedValue({ $kind: "Transaction", Transaction: bare });
      const result = await scheme.settle(await payment(), testRequirements());
      expect(result).toMatchObject({ errorReason: "transaction_failed", transaction: "bare" });
    });

    it("succeeds on executed effects that contain the exact transfer", async () => {
      settled(successRecord(exactBalanceChanges(), "settled-digest"));
      const result = await scheme.settle(await payment(), testRequirements());
      expect(result).toMatchObject({ success: true, transaction: "settled-digest", payer });
      expect(mock.core.simulateTransaction).not.toHaveBeenCalled();
    });

    it("passes a signature array through to execution", async () => {
      const owner = new Ed25519Keypair();
      const transaction = await buildTestTransaction({ gasOwner: owner.toSuiAddress() });
      const signature = [await signOnly(transaction), await signOnly(transaction, owner)];
      settled(successRecord(exactBalanceChanges(), "multi-sig-digest"));
      const result = await scheme.settle(
        testPayload({ transaction, signature }),
        testRequirements(),
      );
      expect(result.success).toBe(true);
      expect(mock.core.executeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ signatures: signature }),
      );
    });

    it("fails when execution commits a failed transaction", async () => {
      mock.core.executeTransaction.mockResolvedValue({
        $kind: "FailedTransaction",
        FailedTransaction: failureRecord("abort"),
      });
      const result = await scheme.settle(await payment(), testRequirements());
      expect(result.errorReason).toBe("transaction_failed");
    });

    it("fails when executed effects do not match the requirements", async () => {
      settled(successRecord(exactBalanceChanges("9999"), "short"));
      const result = await scheme.settle(await payment(), testRequirements());
      expect(result.errorReason).toBe("settlement_effects_mismatch");
    });

    describe("dedup", () => {
      it("rejects a repeat settle of a successful payment", async () => {
        const payload = await payment();
        settled(successRecord(exactBalanceChanges(), "orig"));
        const first = await scheme.settle(payload, testRequirements());
        const second = await scheme.settle(payload, testRequirements());
        expect(first.success).toBe(true);
        expect(second).toMatchObject({
          success: false,
          errorReason: "duplicate_settlement",
          payer,
        });
        expect(mock.core.executeTransaction).toHaveBeenCalledOnce();
      });

      it("rejects a concurrent settle of the same payment", async () => {
        const payload = await payment();
        settled(successRecord(exactBalanceChanges(), "orig"));
        const results = await Promise.all([
          scheme.settle(payload, testRequirements()),
          scheme.settle(payload, testRequirements()),
        ]);
        expect(results.map(r => r.errorReason ?? "ok").sort()).toEqual([
          "duplicate_settlement",
          "ok",
        ]);
      });

      it("does not let a forged settle block the genuine one", async () => {
        const transaction = await buildTestTransaction();
        const forged = testPayload({
          transaction,
          signature: await signOnly(transaction, new Ed25519Keypair()),
        });
        expect((await scheme.settle(forged, testRequirements())).errorReason).toBe(
          "invalid_exact_sui_payload_invalid_signature",
        );
        settled(successRecord(exactBalanceChanges(), "genuine"));
        const genuine = await scheme.settle(
          testPayload(await signPayload(transaction)),
          testRequirements(),
        );
        expect(genuine).toMatchObject({ success: true, transaction: "genuine" });
      });

      it.each([
        [
          "a failed transaction",
          (core: ReturnType<typeof mockClient>["core"]) =>
            core.executeTransaction.mockResolvedValueOnce({
              $kind: "FailedTransaction",
              FailedTransaction: failureRecord("abort"),
            }),
          "transaction_failed",
        ],
        [
          "a thrown execute",
          (core: ReturnType<typeof mockClient>["core"]) =>
            core.executeTransaction.mockRejectedValueOnce(new Error("fullnode unavailable")),
          "transaction_failed",
        ],
        [
          "an effects mismatch",
          (core: ReturnType<typeof mockClient>["core"]) =>
            core.waitForTransaction.mockResolvedValueOnce({
              $kind: "Transaction",
              Transaction: successRecord(exactBalanceChanges("1")),
            }),
          "settlement_effects_mismatch",
        ],
      ])("releases the claim after %s", async (_, fail, reason) => {
        const payload = await payment();
        settled(successRecord(exactBalanceChanges(), "retried"));
        fail(mock.core);
        expect((await scheme.settle(payload, testRequirements())).errorReason).toBe(reason);
        expect(await scheme.settle(payload, testRequirements())).toMatchObject({
          success: true,
          transaction: "retried",
        });
      });

      it("releases the claim after a sponsor rejection", async () => {
        const executeTransaction = vi
          .fn()
          .mockResolvedValueOnce({ $kind: "Rejected", reason: "over budget" })
          .mockImplementationOnce(executed);
        mock.core.waitForTransaction.mockResolvedValue({
          $kind: "Transaction",
          Transaction: successRecord(exactBalanceChanges(), "sponsored"),
        });
        const s = new ExactSuiScheme({
          clients: { [SUI_TESTNET_CAIP2]: mock.client },
          feePayer,
          executeTransaction,
        });
        const requirements = testRequirements({ extra: { feePayer } });
        const payload = await payment({ sponsored: true }, requirements);
        expect((await s.settle(payload, requirements)).errorReason).toBe("sponsor_rejected");
        expect((await s.settle(payload, requirements)).success).toBe(true);
      });

      it("claims after validation with the digest and maxEpoch, and releases on failure", async () => {
        const guard: SettlementGuard = {
          claim: vi.fn().mockResolvedValue(true),
          release: vi.fn(),
        };
        const s = new ExactSuiScheme({
          clients: { [SUI_TESTNET_CAIP2]: mock.client },
          settlementGuard: guard,
        });
        const transaction = await buildTestTransaction();
        const forged = testPayload({
          transaction,
          signature: await signOnly(transaction, new Ed25519Keypair()),
        });
        await s.settle(forged, testRequirements());
        expect(guard.claim).not.toHaveBeenCalled();

        mock.core.executeTransaction.mockRejectedValue(new Error("boom"));
        await s.settle(testPayload(await signPayload(transaction)), testRequirements());
        const key = {
          network: SUI_TESTNET_CAIP2,
          digest: await digestOf(transaction),
          maxEpoch: String(EPOCH + 1),
        };
        expect(guard.claim).toHaveBeenCalledWith(key);
        expect(guard.release).toHaveBeenCalledWith(key);
      });

      it("reports a duplicate when a shared guard refuses the claim", async () => {
        const s = new ExactSuiScheme({
          clients: { [SUI_TESTNET_CAIP2]: mock.client },
          settlementGuard: { claim: async () => false, release: vi.fn() },
        });
        expect((await s.settle(await payment(), testRequirements())).errorReason).toBe(
          "duplicate_settlement",
        );
        expect(mock.core.executeTransaction).not.toHaveBeenCalled();
      });

      it("keeps a successful claim through maxEpoch, then refuses by epoch", async () => {
        const payload = await payment({ expiration: validDuring(EPOCH, EPOCH + 1) });
        settled(successRecord(exactBalanceChanges(), "a"));
        expect((await scheme.settle(payload, testRequirements())).success).toBe(true);

        mock.core.getCurrentSystemState.mockResolvedValue({
          systemState: { epoch: String(EPOCH + 1) },
        });
        expect((await scheme.settle(payload, testRequirements())).errorReason).toBe(
          "duplicate_settlement",
        );

        mock.core.getCurrentSystemState.mockResolvedValue({
          systemState: { epoch: String(EPOCH + 2) },
        });
        expect((await scheme.settle(payload, testRequirements())).errorReason).toBe(
          "invalid_exact_sui_payload_invalid_expiration",
        );
        expect(mock.core.executeTransaction).toHaveBeenCalledOnce();
      });
    });

    describe("ambiguous submission", () => {
      it("reports the real outcome found by digest after a thrown execute", async () => {
        const payload = await payment();
        const digest = await digestOf((payload.payload as { transaction: string }).transaction);
        mock.core.executeTransaction.mockRejectedValue(new Error("deadline exceeded"));
        mock.core.getTransaction.mockResolvedValue({
          $kind: "Transaction",
          Transaction: successRecord(exactBalanceChanges(), digest),
        });
        const result = await scheme.settle(payload, testRequirements());
        expect(result).toMatchObject({ success: true, transaction: digest, payer });
        expect(mock.core.getTransaction).toHaveBeenCalledWith({
          digest,
          include: { balanceChanges: true },
        });
      });

      it("reports the real outcome after the finality wait throws", async () => {
        mock.core.executeTransaction.mockResolvedValue({
          $kind: "Transaction",
          Transaction: successRecord([], "submitted"),
        });
        mock.core.waitForTransaction.mockRejectedValue(new Error("timeout"));
        mock.core.getTransaction.mockResolvedValue({
          $kind: "FailedTransaction",
          FailedTransaction: failureRecord("abort", "landed-failed"),
        });
        const result = await scheme.settle(await payment(), testRequirements());
        expect(result).toMatchObject({
          errorReason: "transaction_failed",
          transaction: "landed-failed",
        });
      });

      it("reports an unknown outcome with the digest and releases the claim", async () => {
        const payload = await payment();
        const digest = await digestOf((payload.payload as { transaction: string }).transaction);
        mock.core.executeTransaction.mockRejectedValueOnce(new Error("fullnode unavailable"));
        expect(await scheme.settle(payload, testRequirements())).toMatchObject({
          errorReason: "transaction_failed",
          errorMessage: "fullnode unavailable",
          transaction: digest,
          payer,
        });
        settled(successRecord(exactBalanceChanges(), digest));
        expect((await scheme.settle(payload, testRequirements())).success).toBe(true);
      });
    });
  });

  describe("requirements", () => {
    it.each(["0", "-1", "1.5", "abc", ""])(
      "rejects amount %j at verify and settle",
      async amount => {
        const requirements = testRequirements({ amount });
        const payload = await payment({}, requirements);
        expect((await scheme.verify(payload, requirements)).invalidReason).toBe(
          "invalid_payment_requirements",
        );
        expect((await scheme.settle(payload, requirements)).errorReason).toBe(
          "invalid_payment_requirements",
        );
        expect(mock.core.simulateTransaction).not.toHaveBeenCalled();
        expect(mock.core.executeTransaction).not.toHaveBeenCalled();
      },
    );

    it("rejects non-empty splits at verify and settle", async () => {
      const requirements = testRequirements({
        extra: { splits: [{ payTo: feePayer, amount: "100" }] },
      });
      const payload = await payment({}, requirements);
      const verified = await scheme.verify(payload, requirements);
      expect(verified.invalidReason).toBe("invalid_payment_requirements");
      expect(verified.invalidMessage).toContain("splits");
      expect((await scheme.settle(payload, requirements)).errorReason).toBe(
        "invalid_payment_requirements",
      );
      expect(mock.core.simulateTransaction).not.toHaveBeenCalled();
      expect(mock.core.executeTransaction).not.toHaveBeenCalled();
    });

    it("accepts an empty splits array", async () => {
      const requirements = testRequirements({ extra: { splits: [] } });
      const result = await scheme.verify(await payment({}, requirements), requirements);
      expect(result.isValid).toBe(true);
    });
  });

  describe("splits", () => {
    const platform = `0x${"aa".repeat(32)}`;
    const referrer = `0x${"bb".repeat(32)}`;
    const splits = [
      { payTo: platform, amount: "300", memo: "platform fee" },
      { payTo: referrer, amount: "200" },
    ];
    const requirements = testRequirements({ extra: { splits } });
    let splitting: ExactSuiScheme;

    /**
     * Balance changes for a payment of 10000 to the given shares.
     *
     * @param shares - Recipient and amount pairs
     * @returns Balance change list
     */
    function credits(...shares: [string, string][]) {
      return [
        { coinType: USDC_TESTNET, address: payer, amount: "-10000" },
        ...shares.map(([address, amount]) => ({ coinType: USDC_TESTNET, address, amount })),
      ];
    }
    const exactSplit = credits([payTo, "9500"], [platform, "300"], [referrer, "200"]);

    /**
     * Mock the simulated balance changes.
     *
     * @param balanceChanges - The balance changes
     */
    function simulated(balanceChanges: ReturnType<typeof credits>) {
      mock.core.simulateTransaction.mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord(balanceChanges),
      });
    }

    beforeEach(() => {
      splitting = new ExactSuiScheme({
        clients: { [SUI_TESTNET_CAIP2]: mock.client },
        maxSplits: 8,
      });
      simulated(exactSplit);
    });

    it("advertises maxSplits with or without a fee payer", () => {
      expect(splitting.getExtra(SUI_TESTNET_CAIP2)).toEqual({ maxSplits: 8 });
      const sponsoring = new ExactSuiScheme({
        feePayer,
        executeTransaction: vi.fn(),
        maxSplits: 2,
      });
      expect(sponsoring.getExtra(SUI_TESTNET_CAIP2)).toEqual({
        feePayer,
        maxGasBudget: "10000000",
        maxSplits: 2,
      });
      expect(new ExactSuiScheme({ maxSplits: 0 }).getExtra(SUI_TESTNET_CAIP2)).toBeUndefined();
    });

    it.each([-1, 1.5, 9, Number.NaN])("rejects maxSplits %j", maxSplits => {
      expect(() => new ExactSuiScheme({ maxSplits })).toThrow("maxSplits must be an integer");
    });

    it("verifies and settles a payment that credits each recipient its share", async () => {
      const payload = await payment({}, requirements);
      expect(await splitting.verify(payload, requirements)).toEqual({
        isValid: true,
        invalidReason: undefined,
        payer,
      });
      settled(
        successRecord(
          exactSplit,
          await digestOf((payload.payload as { transaction: string }).transaction),
        ),
      );
      expect((await splitting.settle(payload, requirements)).success).toBe(true);
    });

    it("rejects splits by default, at verify and settle", async () => {
      const payload = await payment({}, requirements);
      const verified = await scheme.verify(payload, requirements);
      expect(verified.invalidReason).toBe("invalid_payment_requirements");
      expect(verified.invalidMessage).toContain("does not accept splits");
      expect((await scheme.settle(payload, requirements)).errorReason).toBe(
        "invalid_payment_requirements",
      );
    });

    it("rejects more splits than maxSplits", async () => {
      const one = new ExactSuiScheme({
        clients: { [SUI_TESTNET_CAIP2]: mock.client },
        maxSplits: 1,
      });
      const result = await one.verify(await payment({}, requirements), requirements);
      expect(result.invalidReason).toBe("invalid_payment_requirements");
      expect(result.invalidMessage).toContain("accepts at most 1");
      expect(mock.core.simulateTransaction).not.toHaveBeenCalled();
    });

    it.each<[string, unknown]>([
      ["a remainder of zero", [{ payTo: platform, amount: "10000" }]],
      ["a split to payTo", [{ payTo, amount: "1" }]],
      ["an unknown field", [{ payTo: platform, amount: "1", ataCreationRequired: false }]],
      ["a non-array", { payTo: platform, amount: "1" }],
    ])("rejects %s as invalid requirements", async (_, bad) => {
      const badRequirements = testRequirements({ extra: { splits: bad } });
      const payload = await payment({}, badRequirements);
      expect((await splitting.verify(payload, badRequirements)).invalidReason).toBe(
        "invalid_payment_requirements",
      );
      expect((await splitting.settle(payload, badRequirements)).errorReason).toBe(
        "invalid_payment_requirements",
      );
      expect(mock.core.simulateTransaction).not.toHaveBeenCalled();
      expect(mock.core.executeTransaction).not.toHaveBeenCalled();
    });

    it.each<[string, ReturnType<typeof credits>, string]>([
      ["pays the total to payTo", credits([payTo, "10000"]), `recipient ${payTo} credited 10000`],
      [
        "skips a split",
        credits([payTo, "9800"], [platform, "300"]),
        `recipient ${payTo} credited 9800`,
      ],
      [
        "underpays a split",
        credits([payTo, "9500"], [platform, "300"], [referrer, "199"]),
        `recipient ${referrer} credited 199`,
      ],
      [
        "overpays a split",
        credits([payTo, "9500"], [platform, "301"], [referrer, "200"]),
        `recipient ${platform} credited 301`,
      ],
    ])("rejects a payment that %s", async (_, balanceChanges, message) => {
      simulated(balanceChanges);
      const result = await splitting.verify(await payment({}, requirements), requirements);
      expect(result.invalidReason).toBe("invalid_exact_sui_payload_transfer_mismatch");
      expect(result.invalidMessage).toContain(message);
    });

    it("rejects executed effects that miss a share", async () => {
      const payload = await payment({}, requirements);
      const digest = await digestOf((payload.payload as { transaction: string }).transaction);
      settled(successRecord(credits([payTo, "9500"], [platform, "300"]), digest));
      const result = await splitting.settle(payload, requirements);
      expect(result.errorReason).toBe("settlement_effects_mismatch");
      expect(result.errorMessage).toContain(`recipient ${referrer} credited 0`);
    });

    it("reads splits from the requirements, not from payload.accepted", async () => {
      // The client cannot add splits: the server's requirements have none.
      const payload = await payment({}, requirements);
      simulated(exactBalanceChanges());
      expect((await splitting.verify(payload, testRequirements())).isValid).toBe(true);
    });

    describe("sponsored", () => {
      let sponsoring: ExactSuiScheme;
      const sponsoredRequirements = testRequirements({ extra: { feePayer, splits } });

      beforeEach(() => {
        sponsoring = new ExactSuiScheme({
          clients: { [SUI_TESTNET_CAIP2]: mock.client },
          feePayer,
          executeTransaction: async ({ transaction }) => ({
            $kind: "Transaction",
            Transaction: successRecord(exactSplit, await Transaction.from(transaction).getDigest()),
          }),
          maxSplits: 8,
        });
      });

      it("verifies and settles a sponsored split payment", async () => {
        const payload = await payment({ sponsored: true }, sponsoredRequirements);
        expect((await sponsoring.verify(payload, sponsoredRequirements)).isValid).toBe(true);
        const digest = await digestOf((payload.payload as { transaction: string }).transaction);
        mock.core.waitForTransaction.mockResolvedValue({
          $kind: "Transaction",
          Transaction: successRecord(exactSplit, digest),
        });
        expect((await sponsoring.settle(payload, sponsoredRequirements)).success).toBe(true);
      });

      it("keeps the sponsorship checks", async () => {
        const result = await sponsoring.verify(
          await payment({ sponsored: true, useGasCoin: true }, sponsoredRequirements),
          sponsoredRequirements,
        );
        expect(result.invalidReason).toBe("invalid_exact_sui_payload_sponsorship_rejected");
      });

      it("accepts the sponsor as a split recipient of a non-SUI asset", async () => {
        const toSponsor = testRequirements({
          extra: { feePayer, splits: [{ payTo: feePayer, amount: "100", memo: "gas" }] },
        });
        simulated(credits([payTo, "9900"], [feePayer, "100"]));
        const result = await sponsoring.verify(
          await payment({ sponsored: true }, toSponsor),
          toSponsor,
        );
        expect(result.isValid).toBe(true);
      });
    });
  });

  describe("check order", () => {
    it("reports a missing nonce before an invalid expiration", async () => {
      const requirements = testRequirements({ extra: { nonce: NONCE } });
      const result = await scheme.verify(
        await payment({ expiration: { None: true } }, requirements),
        requirements,
      );
      expect(result.invalidReason).toBe("invalid_exact_sui_payload_missing_nonce");
    });

    it("reports an invalid expiration before a sponsorship problem", async () => {
      const s = new ExactSuiScheme({
        clients: { [SUI_TESTNET_CAIP2]: mock.client },
        feePayer,
        executeTransaction: vi.fn(),
      });
      const result = await s.verify(
        await payment({ sponsored: true, useGasCoin: true, expiration: { None: true } }),
        testRequirements(),
      );
      expect(result.invalidReason).toBe("invalid_exact_sui_payload_invalid_expiration");
      expect(result.invalidMessage).toContain("expiration must be ValidDuring or Validity");
    });
  });

  describe("multisig", () => {
    it("verifies a multisig sender", async () => {
      const members = [new Ed25519Keypair(), new Ed25519Keypair()];
      const multisig = MultiSigPublicKey.fromPublicKeys({
        threshold: 1,
        publicKeys: members.map(m => ({ publicKey: m.getPublicKey(), weight: 1 })),
      });
      const sender = multisig.toSuiAddress();
      const transaction = await buildTestTransaction({ sender });
      const signature = multisig.combinePartialSignatures([
        await signOnly(transaction, members[1]),
      ]);
      const result = await scheme.verify(
        testPayload({ transaction, signature }),
        testRequirements(),
      );
      expect(result).toEqual({ isValid: true, invalidReason: undefined, payer: sender });
    });

    it("verifies a zkLogin member of a multisig sender through the network client", async () => {
      const iss = "https://accounts.google.com";
      const addressSeed = 12345n;
      const zkLoginKey = toZkLoginPublicIdentifier(addressSeed, iss, { legacyAddress: false });
      const multisig = MultiSigPublicKey.fromPublicKeys({
        threshold: 1,
        publicKeys: [
          { publicKey: zkLoginKey, weight: 1 },
          { publicKey: new Ed25519Keypair().getPublicKey(), weight: 1 },
        ],
      });
      const sender = multisig.toSuiAddress();
      const transaction = await buildTestTransaction({ sender });
      const ephemeral = new Ed25519Keypair();
      const zkLoginSignature = getZkLoginSignature({
        inputs: {
          proofPoints: { a: ["1"], b: [["1"]], c: ["1"] },
          issBase64Details: {
            value: Buffer.from(`"iss":"${iss}",`).toString("base64url"),
            indexMod4: 0,
          },
          headerBase64: "e30",
          addressSeed: addressSeed.toString(),
        },
        maxEpoch: String(EPOCH + 1),
        userSignature: await signOnly(transaction, ephemeral),
      });
      const signature = multisig.combinePartialSignatures([zkLoginSignature]);
      const verifyZkLoginSignature = vi.fn().mockResolvedValue({ success: true, errors: [] });
      Object.assign(mock.core, { verifyZkLoginSignature });

      const result = await scheme.verify(
        testPayload({ transaction, signature }),
        testRequirements(),
      );

      expect(result).toEqual({ isValid: true, invalidReason: undefined, payer: sender });
      expect(verifyZkLoginSignature).toHaveBeenCalledWith(
        expect.objectContaining({
          bytes: transaction,
          intentScope: "TransactionData",
          address: zkLoginKey.toSuiAddress(),
        }),
      );
    });
  });

  describe("routing", () => {
    /**
     * A facilitator with a fee payer and a mock executor.
     *
     * @returns The scheme and the executor mock
     */
    function sponsoring() {
      const executeTransaction = vi.fn();
      const s = new ExactSuiScheme({
        clients: { [SUI_TESTNET_CAIP2]: mock.client },
        feePayer,
        executeTransaction,
      });
      return { s, executeTransaction };
    }

    it("submits a self-paid payment directly even when a fee payer is configured", async () => {
      const { s, executeTransaction } = sponsoring();
      settled(successRecord(exactBalanceChanges(), "direct"));
      expect((await s.settle(await payment(), testRequirements())).success).toBe(true);
      expect(executeTransaction).not.toHaveBeenCalled();
      expect(mock.core.executeTransaction).toHaveBeenCalledOnce();
    });

    it("submits a client-sponsored payment directly", async () => {
      const { s, executeTransaction } = sponsoring();
      const owner = new Ed25519Keypair();
      const transaction = await buildTestTransaction({ gasOwner: owner.toSuiAddress() });
      const signature = [await signOnly(transaction), await signOnly(transaction, owner)];
      settled(successRecord(exactBalanceChanges(), "direct"));
      const result = await s.settle(testPayload({ transaction, signature }), testRequirements());
      expect(result.success).toBe(true);
      expect(executeTransaction).not.toHaveBeenCalled();
      expect(mock.core.executeTransaction).toHaveBeenCalledOnce();
    });

    it("reports a repeat sponsored settle as a duplicate", async () => {
      const { s, executeTransaction } = sponsoring();
      executeTransaction.mockImplementation(executed);
      mock.core.waitForTransaction.mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord(exactBalanceChanges(), "sponsored"),
      });
      const requirements = testRequirements({ extra: { feePayer } });
      const payload = await payment({ sponsored: true }, requirements);
      expect((await s.settle(payload, requirements)).success).toBe(true);
      expect((await s.settle(payload, requirements)).errorReason).toBe("duplicate_settlement");
      expect(executeTransaction).toHaveBeenCalledOnce();
    });
  });

  describe("epoch boundary", () => {
    it("still rejects a re-settle on a lagging node after a later epoch was seen", async () => {
      const epochIs = (epoch: number) =>
        mock.core.getCurrentSystemState.mockResolvedValue({
          systemState: { epoch: String(epoch) },
        });
      settled(successRecord(exactBalanceChanges()));
      const a = await payment({ expiration: validDuring(100, 101) });
      const b = await payment({ amount: 2, expiration: validDuring(101, 102) });

      epochIs(101);
      expect((await scheme.settle(a, testRequirements())).success).toBe(true);
      epochIs(102);
      expect((await scheme.settle(b, testRequirements())).success).toBe(true);
      epochIs(101);
      expect((await scheme.settle(a, testRequirements())).errorReason).toBe("duplicate_settlement");
    });
  });

  describe("executor", () => {
    /**
     * A facilitator with a mock executor and sponsored requirements.
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
      return { s, executeTransaction, requirements: testRequirements({ extra: { feePayer } }) };
    }

    it("requires an executor when a fee payer is set", () => {
      expect(() => new ExactSuiScheme({ feePayer })).toThrow("executeTransaction");
    });

    it("advertises the fee payer via getExtra / getSigners", () => {
      const { s } = withExecutor(null);
      expect(s.getExtra(SUI_TESTNET_CAIP2)).toEqual({ feePayer, maxGasBudget: "10000000" });
      expect(s.getSigners(SUI_TESTNET_CAIP2)).toEqual([feePayer]);
    });

    it("advertises nothing without a fee payer", () => {
      expect(scheme.getExtra(SUI_TESTNET_CAIP2)).toBeUndefined();
      expect(scheme.getSigners(SUI_TESTNET_CAIP2)).toEqual([]);
    });

    it("settles a sponsored payment through the executor", async () => {
      const { s, executeTransaction, requirements } = withExecutor(null);
      executeTransaction.mockImplementation(executed);
      const payload = await payment({ sponsored: true }, requirements);
      const digest = await digestOf((payload.payload as { transaction: string }).transaction);
      mock.core.waitForTransaction.mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord(exactBalanceChanges(), digest),
      });
      const result = await s.settle(payload, requirements);
      expect(result).toMatchObject({ success: true, transaction: digest });
      expect(executeTransaction).toHaveBeenCalledOnce();
      expect(mock.core.executeTransaction).not.toHaveBeenCalled();
      expect(mock.core.waitForTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ digest }),
      );
    });

    it("fails and releases the claim when the executor submits a different digest", async () => {
      const { s, executeTransaction, requirements } = withExecutor({
        $kind: "Transaction",
        Transaction: successRecord(exactBalanceChanges(), "other-digest"),
      });
      const payload = await payment({ sponsored: true }, requirements);
      expect(await s.settle(payload, requirements)).toMatchObject({
        success: false,
        errorReason: "transaction_failed",
        transaction: "other-digest",
      });
      expect(mock.core.waitForTransaction).not.toHaveBeenCalled();

      executeTransaction.mockImplementation(executed);
      mock.core.waitForTransaction.mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord(exactBalanceChanges(), "retried"),
      });
      expect((await s.settle(payload, requirements)).success).toBe(true);
    });

    it("does not simulate a sponsored payment at settle", async () => {
      const { s, executeTransaction, requirements } = withExecutor(null);
      executeTransaction.mockImplementation(executed);
      mock.core.waitForTransaction.mockResolvedValue({
        $kind: "Transaction",
        Transaction: successRecord(exactBalanceChanges(), "sponsored"),
      });
      const result = await s.settle(await payment({ sponsored: true }, requirements), requirements);
      expect(result.success).toBe(true);
      expect(mock.core.simulateTransaction).not.toHaveBeenCalled();
    });

    it("rejects a payment that fails the sponsorship checks before calling the executor", async () => {
      const { s, executeTransaction, requirements } = withExecutor(null);
      const result = await s.settle(
        await payment({ sponsored: true, useGasCoin: true }, requirements),
        requirements,
      );
      expect(result.errorReason).toBe("invalid_exact_sui_payload_sponsorship_rejected");
      expect(executeTransaction).not.toHaveBeenCalled();
    });

    it("reports a policy rejection as sponsor_rejected", async () => {
      const { s, requirements } = withExecutor({
        $kind: "Rejected",
        reason: "package not allowed",
      });
      const result = await s.settle(await payment({ sponsored: true }, requirements), requirements);
      expect(result).toMatchObject({
        errorReason: "sponsor_rejected",
        errorMessage: "package not allowed",
      });
    });

    it("fails when the executor's transaction aborts on-chain", async () => {
      const { s, requirements } = withExecutor({
        $kind: "FailedTransaction",
        FailedTransaction: failureRecord("abort in move call"),
      });
      const result = await s.settle(await payment({ sponsored: true }, requirements), requirements);
      expect(result.errorReason).toBe("transaction_failed");
    });
  });
});

describe("SettlementCache", () => {
  const key = { network: SUI_TESTNET_CAIP2, digest: "d", maxEpoch: "10" };

  it("claims once until released", () => {
    const cache = new SettlementCache();
    expect(cache.claim(key)).toBe(true);
    expect(cache.claim(key)).toBe(false);
    cache.release(key);
    expect(cache.claim(key)).toBe(true);
  });

  it("scopes claims by network", () => {
    const cache = new SettlementCache();
    expect(cache.claim(key)).toBe(true);
    expect(cache.claim({ ...key, network: SUI_MAINNET_CAIP2 })).toBe(true);
  });

  it("drops claims two epochs after maxEpoch on the same network", () => {
    const cache = new SettlementCache();
    cache.claim(key);
    cache.observeEpoch(SUI_TESTNET_CAIP2, "11");
    cache.observeEpoch(SUI_MAINNET_CAIP2, "50");
    expect(cache.claim(key)).toBe(false);
    cache.observeEpoch(SUI_TESTNET_CAIP2, "12");
    expect(cache.claim(key)).toBe(true);
  });
});
