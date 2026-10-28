import { isDeepStrictEqual } from "node:util";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { errorMessage, parseTransferExecutorPayload } from "../../internal";
import type { HederaContractExecuteResult } from "../../signer";
import type { HederaTransactionRecord } from "../../types";
import { isExecutorAdmitted, type TransferExecutorSigner } from "./config";
import {
  ErrExecutorNotAdmitted,
  ErrInvalidPayload,
  ErrSettlementPending,
  ErrSettlementStatusNotSuccess,
  ErrUnexpectedSettleError,
} from "./errors";
import { toLongZeroAddress } from "./executeTransferCall";
import {
  transferExecutorInFlightKey,
  type InFlightGuard,
  type InFlightHold,
} from "./inFlightGuard";
import { checkTransferExecutorSettlement, SUCCESS_STATUS } from "./transferExecutorRecord";
import {
  verifyTransferExecutor,
  type PreparedExecuteTransfer,
  type TransferExecutorContext,
} from "./transferExecutorVerify";

/**
 * The facilitator's own accounts, as the record checks need them.
 */
type FacilitatorAddresses = {
  accounts: string[];
  /**
   * Long-zero and alias forms.
   */
  evmAddresses: string[];
};

/**
 * A submitted call whose outcome is not known yet: what a retry needs to judge
 * its record without submitting again.
 */
export type PendingTransferExecutorSettlement = {
  signer: TransferExecutorSigner;
  requirements: PaymentRequirements;
  call: PreparedExecuteTransfer;
  facilitator: FacilitatorAddresses;
  transaction: string;
};

/**
 * What `transferExecutor` settlement reads from the scheme.
 */
export type TransferExecutorSettleContext = TransferExecutorContext & {
  guard: InFlightGuard<PendingTransferExecutorSettlement>;
};

/**
 * A settle response, plus what a retry needs when it is `settlement_pending`.
 */
type SettleOutcome = {
  response: SettleResponse;
  pending?: PendingTransferExecutorSettlement;
};

/**
 * Builds failed settlements for one payment.
 */
type SettleFailure = (
  errorReason: string,
  errorMessage?: string,
  transaction?: string,
) => SettleResponse;

/**
 * Settles a `transferExecutor` payment under the in-flight guard.
 *
 * The key is released on a definite outcome and kept on `settlement_pending`
 * until it expires, so a retry can't submit a second contract call while the
 * first may still land. A retry with the same requirements judges the submitted
 * transaction's record again instead.
 *
 * @param ctx - Signer, config, alias policy and the scheme's guard
 * @param payload - Payment payload
 * @param requirements - Matched requirements
 * @returns Settlement response
 */
export async function settleTransferExecutor(
  ctx: TransferExecutorSettleContext,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<SettleResponse> {
  const parsed = parseTransferExecutorPayload(payload.payload);
  if ("malformedField" in parsed) {
    // Nothing to guard: verification rejects it.
    return (await settleHeld(ctx, payload, requirements)).response;
  }
  const key = transferExecutorInFlightKey(requirements.network, parsed.payload);
  // Core retries a pending settlement once, with the same requirements: re-read
  // the record of the transaction already submitted, and submit nothing.
  const retry = ctx.guard.takePending(key, pending =>
    isDeepStrictEqual(pending.requirements, requirements),
  );
  if (retry !== undefined) {
    return settleUnder(ctx.guard, retry.hold, judgeSubmitted(retry.pending));
  }
  // Before the first await, so an identical concurrent settle sees the key.
  const hold = ctx.guard.tryAcquire(key);
  if (hold === undefined) {
    const fail = failureFor(requirements.network, parsed.payload.payer);
    return fail(ErrInvalidPayload, "payload already in flight");
  }
  return settleUnder(
    ctx.guard,
    hold,
    settleHeld(ctx, payload, requirements, () => ctx.guard.renew(hold)),
  );
}

/**
 * Settles under a hold: keeps the key while the outcome is pending, and releases it otherwise.
 *
 * @param guard - The scheme's guard
 * @param hold - The settle's hold
 * @param settlement - The settle step
 * @returns Settlement response
 */
async function settleUnder(
  guard: InFlightGuard<PendingTransferExecutorSettlement>,
  hold: InFlightHold,
  settlement: Promise<SettleOutcome>,
): Promise<SettleResponse> {
  const { response, pending } = await settlement;
  // On pending the call may still land, so a retry must not submit another.
  if (pending === undefined) {
    guard.release(hold);
  } else {
    guard.holdPending(hold, pending);
  }
  return response;
}

/**
 * Settles once the guard is held: re-verifies (re-simulating), re-checks admission,
 * submits the prepared call and judges its consensus record.
 *
 * @param ctx - Signer, config and alias policy
 * @param payload - Payment payload
 * @param requirements - Matched requirements
 * @param renewHold - Restarts the hold's expiry; absent when no hold was taken
 * @returns Settlement outcome
 */
async function settleHeld(
  ctx: TransferExecutorContext,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  renewHold?: () => void,
): Promise<SettleOutcome> {
  const { network } = requirements;
  // isInFlight stays unset: this settle holds the key it would find.
  const verification = await verifyTransferExecutor(
    { signer: ctx.signer, config: ctx.config, aliasPolicy: ctx.aliasPolicy },
    payload,
    requirements,
  );
  if (verification.call === undefined) {
    const { invalidReason, invalidMessage, payer } = verification.response;
    return { response: failureFor(network, payer)(invalidReason, invalidMessage) };
  }
  const { call, signer } = verification;
  const fail = failureFor(network, call.payer);
  let facilitator: FacilitatorAddresses;
  try {
    facilitator = await resolveFacilitatorAddresses(signer, network);
  } catch (error) {
    return {
      response: fail(
        ErrUnexpectedSettleError,
        `facilitator address resolution failed: ${errorMessage(error)}`,
      ),
    };
  }
  // Read live: the operator may have removed the executor since verification.
  if (!isExecutorAdmitted(ctx.config, network, call.executor)) {
    return { response: fail(ErrExecutorNotAdmitted) };
  }
  // The transaction's valid duration starts here, so the key's TTL does too.
  renewHold?.();
  let submitted: HederaContractExecuteResult;
  try {
    // Exactly as simulated, and the only transaction this method signs.
    submitted = await signer.submitContractExecute({
      network,
      feePayer: call.feePayer,
      contractId: call.executor,
      functionParameters: call.functionParameters,
      gas: call.gas,
    });
  } catch (error) {
    // The capability throws only when nothing was broadcast.
    return { response: fail(ErrUnexpectedSettleError, errorMessage(error)) };
  }
  const transaction = submitted.transactionId;
  const pending: PendingTransferExecutorSettlement = {
    signer,
    requirements,
    call,
    facilitator,
    transaction,
  };
  if (submitted.receiptStatus === undefined) {
    return {
      response: fail(
        ErrSettlementPending,
        "transaction broadcast but its receipt could not be obtained",
        transaction,
      ),
      pending,
    };
  }
  if (submitted.receiptStatus !== SUCCESS_STATUS) {
    return {
      response: fail(
        ErrSettlementStatusNotSuccess,
        `receipt status is ${submitted.receiptStatus}, not SUCCESS`,
        transaction,
      ),
    };
  }
  return judgeSubmitted(pending);
}

/**
 * Reads a submitted call's consensus record and judges it. A record that can't
 * be read yet leaves the settlement pending.
 *
 * @param submitted - The submitted call and what judging its record needs
 * @returns Settlement outcome
 */
async function judgeSubmitted(
  submitted: PendingTransferExecutorSettlement,
): Promise<SettleOutcome> {
  const { signer, requirements, call, facilitator, transaction } = submitted;
  const { network } = requirements;
  const fail = failureFor(network, call.payer);
  let record: HederaTransactionRecord | undefined;
  try {
    record = await signer.getTransactionRecord({ transactionId: transaction, network });
  } catch (error) {
    return {
      response: fail(
        ErrSettlementPending,
        `transaction record could not be obtained: ${errorMessage(error)}`,
        transaction,
      ),
      pending: submitted,
    };
  }
  if (record === undefined) {
    return {
      response: fail(ErrSettlementPending, "transaction record not available yet", transaction),
      pending: submitted,
    };
  }
  return { response: judgeRecord(requirements, call, facilitator, transaction, record) };
}

/**
 * Judges a consensus record: success depends on it alone, never on the receipt or the simulation.
 *
 * @param requirements - Matched requirements
 * @param call - The submitted call
 * @param facilitator - The facilitator's accounts and their EVM addresses
 * @param transaction - Hedera transaction id
 * @param record - Consensus record, children and logs included
 * @returns Settlement response
 */
function judgeRecord(
  requirements: PaymentRequirements,
  call: PreparedExecuteTransfer,
  facilitator: FacilitatorAddresses,
  transaction: string,
  record: HederaTransactionRecord,
): SettleResponse {
  const { network } = requirements;
  const verdict = checkTransferExecutorSettlement(record, {
    asset: requirements.asset,
    amount: requirements.amount,
    payer: call.payer,
    payToAccountId: call.payToAccountId,
    feePayer: call.feePayer,
    facilitatorAccounts: facilitator.accounts,
    facilitatorEvmAddresses: facilitator.evmAddresses,
  });
  if (!verdict.ok) {
    return failureFor(network, call.payer)(verdict.errorReason, verdict.errorMessage, transaction);
  }
  return { success: true, transaction, network, payer: call.payer };
}

/**
 * Resolves every facilitator account to the EVM addresses a contract log can name it by:
 * its long-zero address, plus its alias when it has one.
 *
 * @param signer - Facilitator signer
 * @param network - CAIP-2 network
 * @returns The accounts and their EVM addresses
 * @throws Error on a transport failure or a malformed account id
 */
async function resolveFacilitatorAddresses(
  signer: TransferExecutorSigner,
  network: string,
): Promise<FacilitatorAddresses> {
  const accounts = [...signer.getAddresses()];
  const resolved = await Promise.all(
    accounts.map(account => signer.resolveEvmAddress({ account, network })),
  );
  const evmAddresses = accounts.map(toLongZeroAddress);
  for (const resolution of resolved) {
    // Undefined means not found on this network, so only the long-zero form can name it.
    if (resolution !== undefined) {
      evmAddresses.push(resolution.evmAddress);
    }
  }
  return { accounts, evmAddresses };
}

/**
 * Returns a builder of failed settlements for one payment.
 *
 * @param network - CAIP-2 network
 * @param payer - Payer to report
 * @returns Builder taking the code, an optional detail and, once broadcast, the tx id
 */
function failureFor(network: PaymentRequirements["network"], payer: string): SettleFailure {
  return (errorReason, errorMessage, transaction = "") =>
    errorMessage === undefined
      ? { success: false, network, transaction, errorReason, payer }
      : { success: false, network, transaction, errorReason, errorMessage, payer };
}
