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
   * Settle a payment: re-run the offline checks, check the current epoch is in
   * the transaction's window, claim the digest, then submit and report success
   * only if the executed effects match. The claim is released unless settlement
   * succeeds.
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
    const failure = (errorReason: string, errorMessage?: string, payer = ""): SettleResponse => ({
      success: false,
      errorReason,
      errorMessage,
      transaction: "",
      network,
      payer,
    });

    let validated: ValidatedPayment;
    try {
      validated = await this.validate(payload, requirements);
    } catch (error) {
      return failure("transaction_failed", errorMessage(error));
    }
    if (!validated.ok) {
      return failure(validated.reason, validated.message, validated.payer);
    }

    const { sender, digest, minEpoch, maxEpoch, transactionBytes } = validated;
    const client = this.getClient(network);

    // A fullnode answers a re-submitted, already-executed transaction with its
    // cached effects, without re-checking expiration. Refusing transactions
    // outside their window bounds how long a claim must be kept.
    try {
      const { systemState } = await client.core.getCurrentSystemState();
      const epoch = BigInt(systemState.epoch);
      if (epoch < BigInt(minEpoch) || epoch > BigInt(maxEpoch)) {
        return failure(
          "invalid_exact_sui_payload_invalid_expiration",
          `current epoch ${epoch} is outside the transaction's window ${minEpoch}..${maxEpoch}`,
          sender,
        );
      }
      if (this.guard instanceof SettlementCache) this.guard.observeEpoch(network, epoch);
    } catch (error) {
      return failure("transaction_failed", errorMessage(error), sender);
    }

    const key: SettlementKey = { network, digest, maxEpoch };
    let claimed: boolean;
    try {
      claimed = await this.guard.claim(key);
    } catch (error) {
      return failure("transaction_failed", errorMessage(error), sender);
    }
    if (!claimed) {
      return failure("duplicate_settlement", `transaction ${digest} was already settled`, sender);
    }

    let result: SettleResponse;
    try {
      result = await this.submit(
        payload.payload as ExactSuiPayload,
        transactionBytes,
        digest,
        sender,
        validated.sponsored,
        requirements,
      );
    } catch (error) {
      result = failure("transaction_failed", errorMessage(error), sender);
    }

    if (!result.success) {
      try {
        await this.guard.release(key);
      } catch {
        // If release fails, the claim stays until the guard expires it, and the
        // payer cannot retry before then.
      }
    }
    return result;
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
    if (
      typeof requirements.amount !== "string" ||
      !/^[0-9]+$/.test(requirements.amount) ||
      BigInt(requirements.amount) <= 0n
    ) {
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
   * transaction is looked up by digest once before reporting failure.
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
        return {
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
          payer: sender,
        };
      }
      if (submitted.$kind === "FailedTransaction") {
        return {
          success: false,
          errorReason: "transaction_failed",
          errorMessage: submitted.FailedTransaction.status.error?.message,
          transaction: submitted.FailedTransaction.digest,
          network,
          payer: sender,
        };
      }

      // The executor must submit the bytes the payer signed.
      if (sponsored && submitted.Transaction.digest !== digest) {
        return {
          success: false,
          errorReason: "transaction_failed",
          errorMessage: `executor submitted ${submitted.Transaction.digest}, expected ${digest}`,
          transaction: submitted.Transaction.digest,
          network,
          payer: sender,
        };
      }

      finalized = await client.core.waitForTransaction({
        digest: submitted.Transaction.digest,
        include: { balanceChanges: true },
      });
    } catch (error) {
      const found = await this.lookup(client, digest);
      if (!found) {
        // Outcome unknown: report the digest so the caller can reconcile.
        return {
          success: false,
          errorReason: "transaction_failed",
          errorMessage: errorMessage(error),
          transaction: digest,
          network,
          payer: sender,
        };
      }
      finalized = found;
    }

    if (finalized.$kind === "FailedTransaction") {
      return {
        success: false,
        errorReason: "transaction_failed",
        errorMessage: finalized.FailedTransaction.status.error?.message,
        transaction: finalized.FailedTransaction.digest,
        network,
        payer: sender,
      };
    }

    let transaction = finalized.Transaction;
    if (!Array.isArray(transaction.balanceChanges)) {
      const fetched = await this.lookup(client, digest);
      if (fetched?.$kind !== "Transaction" || !Array.isArray(fetched.Transaction.balanceChanges)) {
        return {
          success: false,
          errorReason: "transaction_failed",
          errorMessage: "balance changes for the executed transaction are unavailable",
          transaction: transaction.digest,
          network,
          payer: sender,
        };
      }
      transaction = fetched.Transaction;
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
  }

  /**
   * Simulate the payment (at verify) and check the recipient's credit.
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
    const simulation = await client.core.simulateTransaction({
      transaction: transactionBytes,
      include: { balanceChanges: true },
      doGasSelection: false,
    } as SuiClientTypes.SimulateTransactionOptions<{ balanceChanges: true }>);
    if (simulation.$kind === "FailedTransaction") {
      return {
        reason: "invalid_exact_sui_payload_simulation_failed",
        message: simulation.FailedTransaction.status.error?.message ?? "simulation failed",
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
