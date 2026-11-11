package org.x402.mechanisms.cardano.chain;

/**
 * Result of a submission.
 *
 * @param txHash the transaction hash the chain layer reported
 * @param status {@link SettlementEvidence.Status#CONFIRMED} when the submitter saw it included,
 *     else {@link SettlementEvidence.Status#MEMPOOL}
 */
public record SubmissionResult(String txHash, SettlementEvidence.Status status) {}
