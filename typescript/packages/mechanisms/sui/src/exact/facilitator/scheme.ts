import { TransactionError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";
import { isValidTransactionSignature } from "@mysten/sui/verify";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { DEFAULT_MAX_SPONSORED_GAS_BUDGET } from "../../constants";
import { SettlementCache } from "../../settlement-cache";
import type {
  ClaimResult,
  ExactSuiPayload,
  FacilitatorSuiOptions,
  SettlementGuard,
  SettlementKey,
  SuiExecutor,
  SuiExecutorResult,
} from "../../types";
import {
  createSuiClientResolver,
  isPositiveAmount,
  matchExactPayment,
  normalizeSignatures,
  parseBase64Bytes,
  transactionCarriesNonce,
  type SuiClientResolver,
} from "../../utils";

type TransactionData = ReturnType<Transaction["getData"]>;

type FinalizedTransaction = SuiClientTypes.TransactionResult<{ balanceChanges: true }>;

/**
 * A payment that passed the offline checks.
 */
type ValidatedPayment =
  | {
      ok: true;
      sender: string;
      transactionBytes: Uint8Array;
      digest: string;
      minEpoch: string;
      maxEpoch: string;
      sponsored: boolean;
    }
  | { ok: false; reason: string; message?: string; payer: string };

type Rejection = { reason: string; message: string };

/**
 * The longest a verify's simulation of a sponsored payment is reused by settle.
 */
const MAX_VERIFIED_SIMULATION_MS = 10 * 60 * 1000;

/**
 * Sui facilitator implementation for the Exact payment scheme. Verification is
 * effects-only: the facilitator checks that the transaction's balance changes
 * credit `payTo` with exactly `amount`, not how the transaction is built.
 * Sponsored payments must also pass the sponsorship checks, which bound what
 * the sponsor can be charged.
 */
export class ExactSuiScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "sui:*";

  private readonly getClient: SuiClientResolver;
  private readonly executeTransaction?: SuiExecutor;
  private readonly feePayer?: string;
  private readonly maxSponsoredGasBudget: bigint;
  private readonly guard: SettlementGuard;
  /**
   * Sponsored payments whose simulation passed at verify, keyed by digest and
   * requirements, with the time the result expires. Lets settle skip a second
   * simulation in the `authorization` flow.
   */
  private readonly verifiedSimulations = new Map<string, number>();

  /**
   * Creates a new ExactSuiScheme facilitator instance.
   *
   * @param options - Optional client overrides, executor, fee payer, gas cap, and guard
   */
  constructor(options?: FacilitatorSuiOptions) {
    if (options?.feePayer && !options.executeTransaction) {
      throw new Error("feePayer requires executeTransaction to add the sponsor's signature");
    }
    this.getClient = createSuiClientResolver(options?.clients);
    this.executeTransaction = options?.executeTransaction;
    this.feePayer = options?.feePayer;
    this.maxSponsoredGasBudget = options?.maxSponsoredGasBudget ?? DEFAULT_MAX_SPONSORED_GAS_BUDGET;
    this.guard = options?.settlementGuard ?? new SettlementCache();
  }

  /**
   * Advertise the fee payer and its gas budget cap when one is configured.
   *
   * @param _ - The network identifier (unused)
   * @returns `{ feePayer, maxGasBudget }` when a fee payer is set, otherwise undefined
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    void _;
    return this.feePayer
      ? { feePayer: this.feePayer, maxGasBudget: String(this.maxSponsoredGasBudget) }
      : undefined;
  }

  /**
   * The facilitator's signing addresses: the fee payer when configured.
   *
   * @param _ - The network identifier (unused)
   * @returns The fee payer address, or none
   */
  getSigners(_: string): string[] {
    void _;
    return this.feePayer ? [this.feePayer] : [];
  }

  /**
   * Verify a payment: offline checks, then not-already-executed, then simulation
   * and the recipient check.
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
      const { transactionBytes, sender, digest } = validated;
      const client = this.getClient(requirements.network);

      // Simulating an executed address-balance transaction still succeeds, so
      // look the digest up to avoid approving a payment that already landed.
      if (await this.isExecuted(client, digest)) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_sui_payload_already_executed",
          invalidMessage: `transaction ${digest} already executed`,
          payer: sender,
        };
      }

      const rejection = await this.simulate(client, transactionBytes, requirements);
      if (rejection) {
        return {
          isValid: false,
          invalidReason: rejection.reason,
          invalidMessage: rejection.message,
          payer: sender,
        };
      }

      if (validated.sponsored) this.recordVerifiedSimulation(digest, requirements);
      return { isValid: true, invalidReason: undefined, payer: sender };
    } catch (error) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_sui_payload_verification_error",
        invalidMessage: errorMessage(error),
        payer: "",
      };
    }
  }

  /**
   * Settle a payment: re-run the offline checks, check the current epoch is in
   * the transaction's window, claim the digest, reject a transaction that
   * already executed (unless this retries the facilitator's own pending
   * submission), then submit and report success only if the executed effects
   * match. The claim is kept on success and on `settlement_pending`, which
   * marks it pending so a retry can proceed.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements
   * @returns Promise resolving to settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network;

    let validated: ValidatedPayment;
    try {
      validated = await this.validate(payload, requirements);
    } catch (error) {
      return settleFailure(network, "transaction_failed", errorMessage(error));
    }
    if (!validated.ok) {
      return settleFailure(network, validated.reason, validated.message, validated.payer);
    }

    const { sender, digest, minEpoch, maxEpoch, transactionBytes, sponsored } = validated;
    const client = this.getClient(network);

    // A fullnode answers a re-submitted, already-executed transaction with its
    // cached effects, without re-checking expiration. Refusing transactions
    // outside their window bounds how long a claim must be kept.
    try {
      const { systemState } = await client.core.getCurrentSystemState();
      const epoch = BigInt(systemState.epoch);
      if (epoch < BigInt(minEpoch) || epoch > BigInt(maxEpoch)) {
        return settleFailure(
          network,
          "invalid_exact_sui_payload_invalid_expiration",
          `current epoch ${epoch} is outside the transaction's window ${minEpoch}..${maxEpoch}`,
          sender,
          // An earlier attempt may have executed it, so return the digest
          // for the caller to reconcile.
          digest,
        );
      }
      await this.guard.observeEpoch?.(network, epoch);
    } catch (error) {
      return settleFailure(network, "transaction_failed", errorMessage(error), sender, digest);
    }

    const key: SettlementKey = { network, digest, maxEpoch };
    let claimed: ClaimResult;
    try {
      claimed = await this.guard.claim(key);
    } catch (error) {
      return settleFailure(network, "transaction_failed", errorMessage(error), sender, digest);
    }
    if (!claimed) {
      return settleFailure(
        network,
        "duplicate_settlement",
        `transaction ${digest} was already settled, or a settle for it is in progress`,
        sender,
      );
    }

    // A new claim says only that this facilitator hasn't settled the digest.
    // Settle can't assume a verify ran (the `upfront` flow), and resubmitting
    // an executed transaction returns its original result as a success, so
    // check the chain unless this retries our own pending submission.
    const retry = claimed === "pending";
    let result: SettleResponse;
    try {
      if (!retry && (await this.isExecuted(client, digest))) {
        // Keep the claim: the transaction can never settle here.
        return settleFailure(
          network,
          "invalid_exact_sui_payload_already_executed",
          `transaction ${digest} already executed`,
          sender,
        );
      }
      result = sponsored
        ? await this.settleSponsored(
            payload.payload as ExactSuiPayload,
            validated,
            requirements,
            retry,
          )
        : await this.submit(
            payload.payload as ExactSuiPayload,
            transactionBytes,
            digest,
            sender,
            false,
            requirements,
          );
    } catch (error) {
      result = settleFailure(network, "transaction_failed", errorMessage(error), sender, digest);
    }

    if (!result.success) {
      try {
        if (result.errorReason === "settlement_pending") {
          await this.guard.markPending(key);
        } else {
          await this.guard.release(key);
        }
      } catch {
        // The claim stays as it was until the guard expires it, and the payer
        // cannot retry before then.
      }
    }
    return result;
  }

  /**
   * Settle a sponsored payment. The sponsor pays gas for whatever it co-signs,
   * so the payment's simulated effects are checked first, unless a recent
   * verify of the same payment already checked them. Settle can't assume a
   * verify ran (the `upfront` flow, or a direct call). On a retry after
   * `settlement_pending`, a transaction that has since executed is reported
   * from its effects without being co-signed again.
   *
   * @param suiPayload - The signed payload
   * @param validated - The payment, after the offline checks
   * @param requirements - The payment requirements
   * @param retry - Whether this retries the facilitator's own pending submission
   * @returns The settlement response
   */
  private async settleSponsored(
    suiPayload: ExactSuiPayload,
    validated: ValidatedPayment & { ok: true },
    requirements: PaymentRequirements,
    retry: boolean,
  ): Promise<SettleResponse> {
    const network = requirements.network;
    const { sender, digest, transactionBytes } = validated;
    const client = this.getClient(network);

    if (!this.takeVerifiedSimulation(digest, requirements)) {
      if (retry) {
        const executed = await this.lookup(client, digest);
        if (executed) return this.finish(client, executed, digest, sender, requirements);
      }

      const rejection = await this.simulate(client, transactionBytes, requirements);
      if (rejection) {
        // A retry after `settlement_pending` can land here while the original
        // submission is still in flight, so return the digest to reconcile.
        return settleFailure(network, rejection.reason, rejection.message, sender, digest);
      }
    }

    return this.submit(suiPayload, transactionBytes, digest, sender, true, requirements);
  }

  /**
   * Record that a sponsored payment's simulation passed at verify. The record
   * lasts `maxTimeoutSeconds`, capped at {@link MAX_VERIFIED_SIMULATION_MS}.
   *
   * @param digest - The transaction digest
   * @param requirements - The requirements it was checked against
   */
  private recordVerifiedSimulation(digest: string, requirements: PaymentRequirements): void {
    const now = Date.now();
    // Map iteration is in insertion order and no entry outlives
    // MAX_VERIFIED_SIMULATION_MS, so stop at the first live entry: each entry
    // is visited once, and an expired entry lingers at most that long.
    for (const [key, expiresAt] of this.verifiedSimulations) {
      if (expiresAt >= now) break;
      this.verifiedSimulations.delete(key);
    }
    const ttl = Math.min(
      Math.max(Number(requirements.maxTimeoutSeconds) || 0, 0) * 1000,
      MAX_VERIFIED_SIMULATION_MS,
    );
    const key = simulationKey(digest, requirements);
    this.verifiedSimulations.delete(key);
    this.verifiedSimulations.set(key, now + ttl);
  }

  /**
   * Consume a verify's record for a sponsored payment.
   *
   * @param digest - The transaction digest
   * @param requirements - The requirements being settled
   * @returns True when verify simulated this payment against these requirements recently
   */
  private takeVerifiedSimulation(digest: string, requirements: PaymentRequirements): boolean {
    const key = simulationKey(digest, requirements);
    const expiresAt = this.verifiedSimulations.get(key);
    this.verifiedSimulations.delete(key);
    return expiresAt !== undefined && expiresAt >= Date.now();
  }

  /**
   * The offline checks shared by verify and settle.
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements
   * @returns The decoded payment, or a typed rejection
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
    if (!isPositiveAmount(requirements.amount)) {
      return {
        ok: false,
        reason: "invalid_payment_requirements",
        message: `amount must be a positive integer, got ${String(requirements.amount)}`,
        payer: "",
      };
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
    let transaction: Transaction;
    try {
      transactionBytes = fromBase64(suiPayload.transaction);
      transaction = Transaction.from(transactionBytes);
    } catch (error) {
      return {
        ok: false,
        reason: "invalid_exact_sui_payload_transaction_could_not_be_decoded",
        message: errorMessage(error),
        payer: "",
      };
    }
    const data = transaction.getData();

    const sender = data.sender;
    if (!sender) {
      return { ok: false, reason: "invalid_exact_sui_payload_missing_sender", payer: "" };
    }

    const sponsored = this.isSponsored(data, sender);
    const signatureProblem = await checkSignatures(
      client,
      transactionBytes,
      signatures,
      requiredSigners(data, sender, sponsored),
    );
    if (signatureProblem) {
      return { ok: false, ...signatureProblem, payer: sender };
    }

    const nonceProblem = this.checkNonce(data, requirements);
    if (nonceProblem) {
      return { ok: false, ...nonceProblem, payer: sender };
    }

    const expiration = checkExpiration(data);
    if ("reason" in expiration) {
      return { ok: false, ...expiration, payer: sender };
    }

    const sponsorshipProblem = sponsored ? this.checkSponsorship(data) : null;
    if (sponsorshipProblem) {
      return { ok: false, ...sponsorshipProblem, payer: sender };
    }

    return {
      ok: true,
      sender,
      transactionBytes,
      digest: await transaction.getDigest(),
      minEpoch: expiration.minEpoch,
      maxEpoch: expiration.maxEpoch,
      sponsored,
    };
  }

  /**
   * Whether the gas owner is the configured fee payer and not the sender.
   *
   * @param data - The decoded transaction data
   * @param sender - The transaction sender
   * @returns True for a payment this facilitator sponsors
   */
  private isSponsored(data: TransactionData, sender: string): boolean {
    if (!this.feePayer || !data.gasData.owner) return false;
    const owner = normalizeSuiAddress(data.gasData.owner);
    return owner === normalizeSuiAddress(this.feePayer) && owner !== normalizeSuiAddress(sender);
  }

  /**
   * The sponsorship checks: gas from the sponsor's address balance, a capped
   * budget, no use of the gas coin, and no withdrawal from the sponsor.
   *
   * @param data - The decoded transaction data of a sponsored payment
   * @returns A rejection, or null when the payment passes
   */
  private checkSponsorship(data: TransactionData): Rejection | null {
    const sponsor = normalizeSuiAddress(this.feePayer!);

    const reject = (message: string) => ({
      reason: "invalid_exact_sui_payload_sponsorship_rejected",
      message,
    });

    if (!data.gasData.payment || data.gasData.payment.length > 0) {
      return reject("sponsored gas payment must be empty");
    }
    const budget = data.gasData.budget == null ? null : BigInt(data.gasData.budget);
    if (budget === null || budget > this.maxSponsoredGasBudget) {
      return reject(`gas budget ${budget} exceeds the sponsor cap ${this.maxSponsoredGasBudget}`);
    }
    if (usesGasCoin(data.commands)) {
      return reject("sponsored transaction uses the gas coin");
    }
    for (const input of data.inputs) {
      const source = input.FundsWithdrawal?.withdrawFrom;
      if (
        source?.Sponsor ||
        (source?.SenderAllowance && normalizeSuiAddress(source.SenderAllowance.funder) === sponsor)
      ) {
        return reject("sponsored transaction withdraws funds from the sponsor");
      }
    }
    return null;
  }

  /**
   * When `requirements.extra.nonce` is declared, require the transaction to carry
   * its Base64-decoded bytes as a `Pure` input.
   *
   * @param data - The decoded transaction data
   * @param requirements - The payment requirements
   * @returns A rejection, or null when the nonce is satisfied (or not declared)
   */
  private checkNonce(data: TransactionData, requirements: PaymentRequirements): Rejection | null {
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
   * Submit the payment, wait for finality, and check the executed effects. A
   * facilitator-sponsored payment goes through the executor; any other goes
   * straight to the network client. If submission or the wait throws, the
   * transaction is looked up by digest once. When it is not found, the outcome
   * is unknown: the submission may still execute, so the result is
   * `settlement_pending` with the digest, and a retry resubmits the same bytes.
   *
   * @param suiPayload - The signed payload
   * @param transactionBytes - The decoded transaction bytes
   * @param digest - The transaction digest
   * @param sender - The transaction sender
   * @param sponsored - Whether this facilitator sponsors the payment
   * @param requirements - The payment requirements
   * @returns The settlement response
   */
  private async submit(
    suiPayload: ExactSuiPayload,
    transactionBytes: Uint8Array,
    digest: string,
    sender: string,
    sponsored: boolean,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network;
    const signatures = normalizeSignatures(suiPayload.signature) ?? [];
    const client = this.getClient(network);

    let finalized: FinalizedTransaction;
    try {
      const submitted: SuiExecutorResult =
        sponsored && this.executeTransaction
          ? await this.executeTransaction({ transaction: transactionBytes, signatures })
          : await client.core.executeTransaction({ transaction: transactionBytes, signatures });

      if (submitted.$kind === "Rejected") {
        return settleFailure(
          network,
          "sponsor_rejected",
          submitted.reason ??
            submitted.issues
              ?.map(i => i.message)
              .filter(Boolean)
              .join("; "),
          sender,
          "",
        );
      }
      if (submitted.$kind === "FailedTransaction") {
        return settleFailure(
          network,
          "transaction_failed",
          submitted.FailedTransaction.status.error?.message,
          sender,
          submitted.FailedTransaction.digest,
        );
      }

      // The executor must submit the bytes the payer signed.
      if (sponsored && submitted.Transaction.digest !== digest) {
        return settleFailure(
          network,
          "transaction_failed",
          `executor submitted ${submitted.Transaction.digest}, expected ${digest}`,
          sender,
          submitted.Transaction.digest,
        );
      }

      finalized = await client.core.waitForTransaction({
        digest: submitted.Transaction.digest,
        include: { balanceChanges: true },
      });
    } catch (error) {
      const found = await this.lookup(client, digest);
      if (!found) {
        // A submission that threw, even without an acknowledgement, may have
        // reached a validator and can still execute. Report it as pending with
        // the digest; a retry resubmits the same signed bytes.
        return settleFailure(network, "settlement_pending", errorMessage(error), sender, digest);
      }
      finalized = found;
    }

    return this.finish(client, finalized, digest, sender, requirements);
  }

  /**
   * Report an executed transaction: success only when it succeeded and its
   * balance changes credit `payTo` with exactly `amount`.
   *
   * @param client - The Sui client
   * @param finalized - The executed transaction
   * @param digest - The transaction digest
   * @param sender - The transaction sender
   * @param requirements - The payment requirements
   * @returns The settlement response
   */
  private async finish(
    client: ClientWithCoreApi,
    finalized: FinalizedTransaction,
    digest: string,
    sender: string,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network;
    if (finalized.$kind === "FailedTransaction") {
      return settleFailure(
        network,
        "transaction_failed",
        finalized.FailedTransaction.status.error?.message,
        sender,
        finalized.FailedTransaction.digest,
      );
    }

    let transaction = finalized.Transaction;
    if (!Array.isArray(transaction.balanceChanges)) {
      const fetched = await this.lookup(client, digest);
      if (fetched?.$kind !== "Transaction" || !Array.isArray(fetched.Transaction.balanceChanges)) {
        return settleFailure(
          network,
          "transaction_failed",
          "balance changes for the executed transaction are unavailable",
          sender,
          transaction.digest,
        );
      }
      transaction = fetched.Transaction;
    }

    const problem = this.matchRecipients(transaction.balanceChanges, requirements);
    if (problem) {
      return settleFailure(
        network,
        "settlement_effects_mismatch",
        problem,
        sender,
        transaction.digest,
      );
    }
    return { success: true, transaction: transaction.digest, network, payer: sender };
  }

  /**
   * Simulate the payment and check the recipient's credit: at verify, and at
   * settle before a sponsor co-signs.
   *
   * @param client - The Sui client
   * @param transactionBytes - The transaction bytes
   * @param requirements - The payment requirements
   * @returns A rejection, or null when the simulated effects match
   */
  private async simulate(
    client: ClientWithCoreApi,
    transactionBytes: Uint8Array,
    requirements: PaymentRequirements,
  ): Promise<Rejection | null> {
    // Without `doGasSelection: false`, gRPC and GraphQL fullnodes may replace an
    // empty gas payment with the gas owner's coins, so the simulation would not
    // be of the signed bytes. JSON-RPC ignores the option and never selects gas.
    // An empty payment may instead receive a mock gas coin; reject its effects
    // because they do not establish that the signed transaction can be funded.
    const simulation = await client.core.simulateTransaction({
      transaction: transactionBytes,
      include: { balanceChanges: true },
      checksEnabled: true,
      doGasSelection: false,
    } as SuiClientTypes.SimulateTransactionOptions<{ balanceChanges: true }>);
    if (simulation.$kind === "FailedTransaction") {
      return {
        reason: "invalid_exact_sui_payload_simulation_failed",
        message: simulation.FailedTransaction.status.error?.message ?? "simulation failed",
      };
    }
    if (simulation.gasPaymentMocked) {
      return {
        reason: "invalid_exact_sui_payload_simulation_failed",
        message: "simulation used a mocked gas payment",
      };
    }
    const problem = this.matchRecipients(simulation.Transaction.balanceChanges, requirements);
    return problem
      ? { reason: "invalid_exact_sui_payload_transfer_mismatch", message: problem }
      : null;
  }

  /**
   * Look a transaction up by digest.
   *
   * @param client - The Sui client
   * @param digest - The transaction digest
   * @returns The executed transaction, or null when it can't be found
   */
  private async lookup(
    client: ClientWithCoreApi,
    digest: string,
  ): Promise<FinalizedTransaction | null> {
    try {
      return await client.core.getTransaction({ digest, include: { balanceChanges: true } });
    } catch {
      return null;
    }
  }

  /**
   * The recipient check: `payTo` must net exactly `amount`.
   *
   * @param balanceChanges - The simulated or executed balance changes
   * @param requirements - The payment requirements
   * @returns A problem description, or null when the effects match
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
   * Whether a transaction digest is already executed.
   *
   * @param client - The Sui client
   * @param digest - The transaction digest
   * @returns True when found, false when the node reports it not found
   */
  private async isExecuted(client: ClientWithCoreApi, digest: string): Promise<boolean> {
    try {
      await client.core.getTransaction({ digest });
      return true;
    } catch (error) {
      if (isTransactionNotFound(error, digest)) return false;
      throw error;
    }
  }
}

/**
 * Require a `ValidDuring` or `Validity` expiration valid in at most two
 * consecutive epochs (maxEpoch - minEpoch <= 1).
 *
 * @param data - The decoded transaction data
 * @returns The first and last valid epochs, or a rejection
 */
function checkExpiration(
  data: TransactionData,
): { minEpoch: string; maxEpoch: string } | Rejection {
  const reject = (message: string) => ({
    reason: "invalid_exact_sui_payload_invalid_expiration",
    message,
  });
  const window = data.expiration?.ValidDuring ?? data.expiration?.Validity;
  if (!window) {
    return reject(
      `expiration must be ValidDuring or Validity, got ${data.expiration?.$kind ?? "None"}`,
    );
  }
  const { minEpoch, maxEpoch } = window;
  if (minEpoch == null || maxEpoch == null) {
    return reject("expiration must set minEpoch and maxEpoch");
  }
  const span = BigInt(maxEpoch) - BigInt(minEpoch);
  if (span < 0n || span > 1n) {
    return reject(
      `expiration spans epochs ${minEpoch} to ${maxEpoch}; it must be valid in at most two consecutive epochs (maxEpoch - minEpoch <= 1)`,
    );
  }
  return { minEpoch: String(minEpoch), maxEpoch: String(maxEpoch) };
}

/**
 * The addresses whose signatures the payload must carry: the sender, plus a
 * gas owner other than the sender, unless that owner is this facilitator's
 * sponsor (which signs at settlement).
 *
 * @param data - The decoded transaction data
 * @param sender - The transaction sender
 * @param sponsored - Whether the gas owner is this facilitator's sponsor
 * @returns The required signer addresses
 */
function requiredSigners(data: TransactionData, sender: string, sponsored: boolean): string[] {
  const owner = data.gasData.owner ? normalizeSuiAddress(data.gasData.owner) : null;
  const signers = [normalizeSuiAddress(sender)];
  if (owner && owner !== signers[0] && !sponsored) signers.push(owner);
  return signers;
}

/**
 * Require exactly one valid signature per required signer. Errors other than an
 * invalid signature (e.g. a failed zkLogin lookup) are thrown, not reported as
 * invalid.
 *
 * @param client - The Sui client (for zkLogin and passkey verification)
 * @param transactionBytes - The transaction bytes
 * @param signatures - The payload signatures
 * @param signers - The required signer addresses
 * @returns A rejection, or null when the signatures match the signers
 */
async function checkSignatures(
  client: ClientWithCoreApi,
  transactionBytes: Uint8Array,
  signatures: string[],
  signers: string[],
): Promise<Rejection | null> {
  const reason = "invalid_exact_sui_payload_invalid_signature";
  if (signatures.length !== signers.length) {
    return {
      reason,
      message: `expected ${signers.length} signature(s), got ${signatures.length}`,
    };
  }
  const unused = [...signatures];
  for (const address of signers) {
    let match = -1;
    for (let i = 0; i < unused.length && match < 0; i++) {
      if (await isValidTransactionSignature(transactionBytes, unused[i], { client, address })) {
        match = i;
      }
    }
    if (match < 0) return { reason, message: `no valid signature from ${address}` };
    unused.splice(match, 1);
  }
  return null;
}

/**
 * Whether any command argument is the gas coin.
 *
 * @param value - Commands, or a part of one
 * @returns True when a `GasCoin` argument is found
 */
function usesGasCoin(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(usesGasCoin);
  if (value !== null && typeof value === "object") {
    if ((value as { $kind?: unknown }).$kind === "GasCoin") return true;
    return Object.values(value).some(usesGasCoin);
  }
  return false;
}

/**
 * Whether an error is the SDK's structured transaction not-found error. The
 * structural check covers a second copy of the SDK, where `instanceof` fails.
 *
 * @param error - The thrown error
 * @param digest - The requested digest
 * @returns True for a not-found lookup of `digest`
 */
function isTransactionNotFound(error: unknown, digest: string): boolean {
  if (error instanceof TransactionError) return error.reason === "notFound";
  const fields = error as { reason?: unknown; digest?: unknown } | null;
  return error instanceof Error && fields?.reason === "notFound" && fields.digest === digest;
}

/**
 * An error's message.
 *
 * @param error - The thrown value
 * @returns Its message
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A failed settlement response.
 *
 * @param network - The CAIP-2 network id
 * @param errorReason - The reason code
 * @param errorMessage - A description of the failure
 * @param payer - The payer, when known
 * @param transaction - The transaction digest, when it may have been submitted
 * @returns The settlement response
 */
function settleFailure(
  network: Network,
  errorReason: string,
  errorMessage?: string,
  payer = "",
  transaction = "",
): SettleResponse {
  return { success: false, errorReason, errorMessage, transaction, network, payer };
}

/**
 * The key for a verified simulation: the transaction and everything the
 * effects check compared it against.
 *
 * @param digest - The transaction digest
 * @param requirements - The payment requirements
 * @returns The map key
 */
function simulationKey(digest: string, requirements: PaymentRequirements): string {
  return JSON.stringify([
    requirements.network,
    digest,
    requirements.asset,
    requirements.payTo,
    requirements.amount,
  ]);
}
