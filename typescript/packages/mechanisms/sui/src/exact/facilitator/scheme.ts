import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { SettlementCache } from "../../settlement-cache";
import type {
  ExactSuiPayload,
  FacilitatorSuiOptions,
  SettlementGuard,
  SettlementKey,
  SuiExecutor,
  SuiExecutorResult,
} from "../../types";
import {
  createSuiClientResolver,
  matchExactPayment,
  normalizeSignatures,
  parseBase64Bytes,
  transactionCarriesNonce,
  type SuiClientResolver,
} from "../../utils";

/**
 * A payment that passed the offline checks. verify then runs the network checks
 * and simulates; settle executes.
 */
type ValidatedPayment =
  | {
      ok: true;
      sender: string;
      transactionBytes: Uint8Array;
      data: ReturnType<Transaction["getData"]>;
    }
  | { ok: false; reason: string; message?: string; payer: string };

/**
 * Sui facilitator implementation for the Exact payment scheme. Verification is
 * effects-only: it checks that `payTo` is credited exactly `amount`, not how the
 * transaction is built. A custom executor, when configured, handles settlement
 * (e.g. a gas sponsor that co-signs under its own policy).
 */
export class ExactSuiScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "sui:*";

  private readonly getClient: SuiClientResolver;
  private readonly executeTransaction?: SuiExecutor;
  private readonly feePayer?: string;
  private readonly guard: SettlementGuard;

  /**
   * Creates a new ExactSuiScheme facilitator instance.
   *
   * @param options - Optional client overrides, executor, fee-payer, and guard
   */
  constructor(options?: FacilitatorSuiOptions) {
    this.getClient = createSuiClientResolver(options?.clients);
    this.executeTransaction = options?.executeTransaction;
    this.feePayer = options?.feePayer;
    this.guard = options?.settlementGuard ?? new SettlementCache();
  }

  /**
   * Advertise the fee-payer address when one is configured; its presence in
   * `extra.feePayer` signals that sponsorship is offered.
   *
   * @param _ - The network identifier (unused)
   * @returns `{ feePayer }` when a fee-payer is set, otherwise undefined
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    void _;
    return this.feePayer ? { feePayer: this.feePayer } : undefined;
  }

  /**
   * The facilitator's signing addresses: the fee-payer address when configured,
   * otherwise none (a self-paid/gasless broadcast needs no facilitator key).
   *
   * @param _ - The network identifier (unused)
   * @returns The fee-payer address array, or empty
   */
  getSigners(_: string): string[] {
    void _;
    return this.feePayer ? [this.feePayer] : [];
  }

  /**
   * Verify a payment: offline checks, then not-already-executed, simulation, and
   * effects-only recipient verification.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements
   * @returns Promise resolving to verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    try {
      const validated = await this.validate(payload, requirements);
      if (!validated.ok) {
        return {
          isValid: false,
          invalidReason: validated.reason,
          invalidMessage: validated.message,
          payer: validated.payer,
        };
      }
      const { transactionBytes, sender } = validated;
      const client = this.getClient(requirements.network);

      // Not-already-executed replay guard (simulation is not a replay guard for
      // Address-Balance-sourced transactions — they have no object inputs).
      const digest = await Transaction.from(transactionBytes).getDigest();
      if (await this.isExecuted(client, digest)) {
        return {
          isValid: false,
          invalidReason: "invalid_transaction_state",
          invalidMessage: `transaction ${digest} already executed`,
          payer: sender,
        };
      }

      const simulation = await client.core.simulateTransaction({
        transaction: transactionBytes,
        include: { balanceChanges: true },
      });
      if (simulation.$kind === "FailedTransaction") {
        return {
          isValid: false,
          invalidReason: "invalid_exact_sui_payload_simulation_failed",
          invalidMessage: simulation.FailedTransaction.status.error?.message,
          payer: sender,
        };
      }

      const problem = this.matchRecipients(simulation.Transaction.balanceChanges, requirements);
      if (problem) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_sui_payload_transfer_mismatch",
          invalidMessage: problem,
          payer: sender,
        };
      }

      return { isValid: true, invalidReason: undefined, payer: sender };
    } catch (error) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_sui_payload_verification_error",
        invalidMessage: error instanceof Error ? error.message : String(error),
        payer: "",
      };
    }
  }

  /**
   * Settle a payment: dedup, re-run the offline checks, then execute (or
   * delegate to the sponsor) and gate success on the executed effects.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements
   * @returns Promise resolving to settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = payload.accepted.network;
    const suiPayload = payload.payload as ExactSuiPayload;

    // Guard against double-serving before validating or executing, keyed on the
    // transaction digest (with the declared nonce, when present, for a shared
    // guard's reconciliation). Re-executing a settled transaction is harmless on
    // Sui; this stops the server serving the same payment twice. A malformed
    // payload yields no key and is rejected by validate() below. Cross-instance
    // exactly-once needs a shared SettlementGuard.
    const settlementKey = await this.settlementKey(suiPayload, requirements);
    if (settlementKey && (await this.guard.isDuplicate(settlementKey))) {
      return {
        success: false,
        network,
        transaction: "",
        errorReason: "duplicate_settlement",
        payer: "",
      };
    }

    try {
      const validated = await this.validate(payload, requirements);
      if (!validated.ok) {
        return {
          success: false,
          network,
          transaction: "",
          errorReason: validated.reason,
          errorMessage: validated.message,
          payer: validated.payer,
        };
      }
      const { transactionBytes, sender } = validated;

      const executed = await this.execute(suiPayload, transactionBytes, requirements);
      if ("failure" in executed) return executed.failure;
      const { transaction } = executed;

      if (!transaction.status.success) {
        return {
          success: false,
          errorReason: "transaction_failed",
          errorMessage: transaction.status.error?.message,
          transaction: transaction.digest,
          network,
          payer: sender,
        };
      }
      const problem = this.matchRecipients(transaction.balanceChanges, requirements);
      if (problem) {
        return {
          success: false,
          errorReason: "settlement_effects_mismatch",
          errorMessage: problem,
          transaction: transaction.digest,
          network,
          payer: sender,
        };
      }
      return { success: true, transaction: transaction.digest, network, payer: sender };
    } catch (error) {
      return {
        success: false,
        errorReason: "transaction_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        transaction: "",
        network,
        payer: "",
      };
    }
  }

  /**
   * The offline checks shared by verify and settle: envelope, signature binding
   * the sender, and the optional declared server nonce.
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements
   * @returns The decoded bytes/data/client/sender, or a typed rejection
   */
  private async validate(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<ValidatedPayment> {
    if (payload.x402Version !== 2) {
      return { ok: false, reason: "invalid_x402_version", payer: "" };
    }
    if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
      return { ok: false, reason: "unsupported_scheme", payer: "" };
    }
    if (payload.accepted.network !== requirements.network) {
      return { ok: false, reason: "network_mismatch", payer: "" };
    }

    let client: ClientWithCoreApi;
    try {
      client = this.getClient(requirements.network);
    } catch {
      return { ok: false, reason: "invalid_network", payer: "" };
    }

    const suiPayload = payload.payload as ExactSuiPayload;
    const signatures = normalizeSignatures(suiPayload?.signature);
    if (typeof suiPayload?.transaction !== "string" || !signatures) {
      return { ok: false, reason: "invalid_payload", payer: "" };
    }

    let transactionBytes: Uint8Array;
    let data: ReturnType<Transaction["getData"]>;
    try {
      transactionBytes = fromBase64(suiPayload.transaction);
      data = Transaction.from(transactionBytes).getData();
    } catch (error) {
      return {
        ok: false,
        reason: "invalid_exact_sui_payload_transaction_could_not_be_decoded",
        message: error instanceof Error ? error.message : String(error),
        payer: "",
      };
    }

    const sender = data.sender;
    if (!sender) {
      return { ok: false, reason: "invalid_exact_sui_payload_missing_sender", payer: "" };
    }

    // A transaction may require more than one signer (e.g. a sponsor distinct
    // from the sender). Verify only that the sender is covered by one of the
    // signatures; other required signers are enforced at execution, not here.
    let senderBound = false;
    let lastError: unknown;
    for (const signature of signatures) {
      try {
        await verifyTransactionSignature(transactionBytes, signature, { client, address: sender });
        senderBound = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!senderBound) {
      return {
        ok: false,
        reason: "invalid_exact_sui_payload_invalid_signature",
        message: lastError instanceof Error ? lastError.message : String(lastError),
        payer: sender,
      };
    }

    const nonceProblem = this.checkNonce(data, requirements);
    if (nonceProblem) {
      return {
        ok: false,
        reason: nonceProblem.reason,
        message: nonceProblem.message,
        payer: sender,
      };
    }

    return { ok: true, sender, transactionBytes, data };
  }

  /**
   * When `requirements.extra.nonce` is declared, require the transaction to carry
   * its Base64-decoded bytes as a `Pure` input. No size cap; a malformed
   * (non-Base64) value is rejected.
   *
   * @param data - The decoded transaction data
   * @param requirements - The payment requirements
   * @returns A rejection, or null when the nonce is satisfied (or not declared)
   */
  private checkNonce(
    data: ReturnType<Transaction["getData"]>,
    requirements: PaymentRequirements,
  ): { reason: string; message: string } | null {
    const declaredNonce = requirements.extra?.nonce;
    if (declaredNonce === undefined) return null;

    if (!parseBase64Bytes(declaredNonce)) {
      return {
        reason: "invalid_exact_sui_payload_missing_nonce",
        message: "requirements.extra.nonce is not valid Base64",
      };
    }
    if (!transactionCarriesNonce(data, declaredNonce as string)) {
      return {
        reason: "invalid_exact_sui_payload_missing_nonce",
        message: "transaction does not carry the declared nonce",
      };
    }

    return null;
  }

  /**
   * Submit the payment and wait for finality, then return the finalized
   * transaction with its balance changes. Submission is delegated to the custom
   * `executeTransaction` when configured (a gas sponsor, for example, co-signs the
   * gas under its own policy or declines); otherwise the signed bytes are
   * broadcast directly via the network client. Balance changes are read from the
   * finalized transaction, not the submission. Sui execution is idempotent, so a
   * retry returns the same effects.
   *
   * @param suiPayload - The signed payload
   * @param transactionBytes - The decoded transaction bytes
   * @param requirements - The payment requirements
   * @returns The finalized transaction, or a settlement failure
   */
  private async execute(
    suiPayload: ExactSuiPayload,
    transactionBytes: Uint8Array,
    requirements: PaymentRequirements,
  ): Promise<
    | { transaction: SuiClientTypes.Transaction<{ balanceChanges: true }> }
    | { failure: SettleResponse }
  > {
    const network = requirements.network;
    const signatures = normalizeSignatures(suiPayload.signature) ?? [];
    const client = this.getClient(network);

    const submitted: SuiExecutorResult = this.executeTransaction
      ? await this.executeTransaction({ transaction: transactionBytes, signatures })
      : await client.core.executeTransaction({ transaction: transactionBytes, signatures });

    if (submitted.$kind === "Rejected") {
      // Wire code stays `sponsor_rejected` (the spec's name for a policy rejection
      // during sponsored settlement) even though the executor is generic.
      return {
        failure: {
          success: false,
          errorReason: "sponsor_rejected",
          errorMessage:
            submitted.reason ??
            submitted.issues
              ?.map(i => i.message)
              .filter(Boolean)
              .join("; "),
          transaction: "",
          network,
          payer: "",
        },
      };
    }
    if (submitted.$kind === "FailedTransaction") {
      return {
        failure: {
          success: false,
          errorReason: "transaction_failed",
          errorMessage: submitted.FailedTransaction.status.error?.message,
          transaction: submitted.FailedTransaction.digest,
          network,
          payer: "",
        },
      };
    }

    // Wait for finality and read the balance changes from the finalized tx.
    const finalized = await client.core.waitForTransaction({
      digest: submitted.Transaction.digest,
      include: { balanceChanges: true },
    });
    if (finalized.$kind === "FailedTransaction") {
      return {
        failure: {
          success: false,
          errorReason: "transaction_failed",
          errorMessage: finalized.FailedTransaction.status.error?.message,
          transaction: finalized.FailedTransaction.digest,
          network,
          payer: "",
        },
      };
    }
    return { transaction: finalized.Transaction };
  }

  /**
   * Effects-only recipient verification against the single declared recipient:
   * `payTo` must net exactly `amount` in the asset.
   *
   * @param balanceChanges - The simulated or executed balance changes
   * @param requirements - The payment requirements
   * @returns A problem string, or null when the effects match
   */
  private matchRecipients(
    balanceChanges: readonly SuiClientTypes.BalanceChange[],
    requirements: PaymentRequirements,
  ): string | null {
    return matchExactPayment(
      balanceChanges,
      requirements.asset,
      requirements.payTo,
      requirements.amount,
    );
  }

  /**
   * The settlement identity for the dedup guard: the transaction digest, plus the
   * declared server nonce when present. Returns undefined for a malformed payload
   * (no dedup possible — validate() rejects it).
   *
   * @param suiPayload - The Sui payload (for the transaction bytes)
   * @param requirements - The payment requirements (for the declared nonce)
   * @returns The settlement key, or undefined when the payload is malformed
   */
  private async settlementKey(
    suiPayload: ExactSuiPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementKey | undefined> {
    if (typeof suiPayload?.transaction !== "string") return undefined;
    let digest: string;
    try {
      digest = await Transaction.from(fromBase64(suiPayload.transaction)).getDigest();
    } catch {
      return undefined;
    }
    const nonce = requirements.extra?.nonce;
    return typeof nonce === "string" ? { digest, nonce } : { digest };
  }

  /**
   * Whether a transaction digest is already committed on-chain.
   *
   * @param client - The Sui client
   * @param digest - The transaction digest
   * @returns True when committed, false when not found
   */
  private async isExecuted(client: ClientWithCoreApi, digest: string): Promise<boolean> {
    try {
      await client.core.getTransaction({ digest });
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "NOT_FOUND") return false;
      throw error;
    }
  }
}
