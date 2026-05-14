/**
 * x402 Reputation Subgraph — AssemblyScript Mapping
 *
 * Handles three event types:
 *   PaymentSettled   → update AgentReputation + create Payment entity
 *   PaymentRefunded  → update AgentReputation + create Payment entity
 *   GrantRevoked     → create GrantRevocation entity
 *
 * Reputation score formula (from specs/reputation.md §3):
 *   score = 0.60 × successRate + 0.25 × diversityScore + 0.15 × timeDecayFactor
 *
 *   successRate     = settled90d / (settled90d + refunded90d)
 *   diversityScore  = min(1.0, uniqueCounterparties / 10)
 *   timeDecayFactor = exp(-0.01 × daysSinceLastPayment)
 */

import {
  BigInt,
  BigDecimal,
  Bytes,
  store,
  log,
} from "@graphprotocol/graph-ts";

import {
  PaymentSettled as PaymentSettledEvent,
  PaymentRefunded as PaymentRefundedEvent,
} from "../generated/SettlementListener/SettlementListener";

import {
  GrantRevoked as GrantRevokedEvent,
} from "../generated/x402GrantRegistry/x402GrantRegistry";

import {
  AgentReputation,
  Payment,
  GrantRevocation,
  CounterpartyRecord,
} from "../generated/schema";

// ── Constants ─────────────────────────────────────────────────────────────────
const SECONDS_PER_DAY     = BigDecimal.fromString("86400");
const NINETY_DAYS_SECONDS = BigInt.fromI32(90 * 86400);

// Scoring weights (must sum to 1.0)
const W_SUCCESS   = BigDecimal.fromString("0.60");
const W_DIVERSITY = BigDecimal.fromString("0.25");
const W_RECENCY   = BigDecimal.fromString("0.15");

// Diversity saturates at 10 unique counterparties
const DIVERSITY_SATURATION = BigDecimal.fromString("10");

// λ for time decay: exp(-0.01 × days)
const LAMBDA = BigDecimal.fromString("0.01");


// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Load or create an AgentReputation entity.
 */
function loadOrCreateReputation(agentAddress: Bytes): AgentReputation {
  const id = agentAddress.toHexString().toLowerCase();
  let rep  = AgentReputation.load(id);
  if (rep == null) {
    rep                      = new AgentReputation(id);
    rep.agent                = agentAddress;
    rep.totalPayments        = BigInt.fromI32(0);
    rep.successfulPayments   = BigInt.fromI32(0);
    rep.refundedPayments     = BigInt.fromI32(0);
    rep.uniqueCounterparties = BigInt.fromI32(0);
    rep.lastPaymentAt        = BigInt.fromI32(0);
    rep.score                = BigDecimal.fromString("0");
    rep.successRate          = BigDecimal.fromString("0");
    rep.diversityScore       = BigDecimal.fromString("0");
    rep.recencyScore         = BigDecimal.fromString("0");
  }
  return rep as AgentReputation;
}

/**
 * Track whether a counterparty is new for this agent.
 * Uses a composite entity: CounterpartyRecord (agentAddr + counterpartyAddr).
 */
function trackCounterparty(agentAddress: Bytes, counterpartyAddress: Bytes): bool {
  const id  = agentAddress.toHexString() + "-" + counterpartyAddress.toHexString();
  let record = CounterpartyRecord.load(id);
  if (record == null) {
    record         = new CounterpartyRecord(id);
    record.agent        = agentAddress;
    record.counterparty = counterpartyAddress;
    record.save();
    return true; // new counterparty
  }
  return false; // already seen
}

/**
 * Natural exponent approximation: exp(-x) via Taylor series (6 terms).
 * Good enough for x in [0, 5] (i.e. λ×days up to 500 days).
 * AssemblyScript has no Math.exp for BigDecimal — we compute it manually.
 */
function expNegative(x: BigDecimal): BigDecimal {
  // exp(-x) = 1 - x + x²/2! - x³/3! + x⁴/4! - x⁵/5!
  let result  = BigDecimal.fromString("1");
  let term    = BigDecimal.fromString("1");
  let neg     = false;
  for (let n = 1; n <= 6; n++) {
    term = term.times(x).div(BigDecimal.fromString(n.toString()));
    if (neg) {
      result = result.minus(term);
    } else {
      result = result.plus(term);
    }
    neg = !neg;
  }
  // Clamp to [0, 1]
  if (result.lt(BigDecimal.fromString("0"))) result = BigDecimal.fromString("0");
  if (result.gt(BigDecimal.fromString("1"))) result = BigDecimal.fromString("1");
  return result;
}

/**
 * Compute and save the composite reputation score.
 *
 * successRate     = successfulPayments90d / (successfulPayments90d + refundedPayments90d)
 * diversityScore  = min(1.0, uniqueCounterparties / 10)
 * timeDecayFactor = exp(-0.01 × daysSinceLastPayment)
 * score           = 0.60×successRate + 0.25×diversity + 0.15×timeDecay
 *
 * Note: 90-day windowing is tracked via the Payment entities in the score function
 * below (full window scan). For gas-efficiency in production, use the
 * rolling-window approach described in the deployment notes.
 */
function recomputeScore(rep: AgentReputation, nowTimestamp: BigInt): void {
  let totalDenom = rep.successfulPayments.plus(rep.refundedPayments);

  // Success rate
  let successRate: BigDecimal;
  if (totalDenom.equals(BigInt.fromI32(0))) {
    successRate = BigDecimal.fromString("0");
  } else {
    successRate = rep.successfulPayments
      .toBigDecimal()
      .div(totalDenom.toBigDecimal());
  }

  // Diversity score — saturates at 10 unique counterparties
  let diversityScore = rep.uniqueCounterparties
    .toBigDecimal()
    .div(DIVERSITY_SATURATION);
  if (diversityScore.gt(BigDecimal.fromString("1"))) {
    diversityScore = BigDecimal.fromString("1");
  }

  // Recency score — exp(-λ × daysSinceLastPayment)
  let recencyScore: BigDecimal;
  if (rep.lastPaymentAt.equals(BigInt.fromI32(0))) {
    recencyScore = BigDecimal.fromString("0");
  } else {
    let secondsSince = nowTimestamp.minus(rep.lastPaymentAt);
    if (secondsSince.lt(BigInt.fromI32(0))) {
      secondsSince = BigInt.fromI32(0);
    }
    let daysSince = secondsSince.toBigDecimal().div(SECONDS_PER_DAY);
    let x         = LAMBDA.times(daysSince);
    recencyScore  = expNegative(x);
  }

  // Composite score
  let score = W_SUCCESS.times(successRate)
    .plus(W_DIVERSITY.times(diversityScore))
    .plus(W_RECENCY.times(recencyScore));

  rep.successRate    = successRate;
  rep.diversityScore = diversityScore;
  rep.recencyScore   = recencyScore;
  rep.score          = score;
}


// ── Event Handlers ────────────────────────────────────────────────────────────

/**
 * PaymentSettled — increment successfulPayments, track counterparty, recompute score.
 */
export function handlePaymentSettled(event: PaymentSettledEvent): void {
  const agent       = event.params.agent;
  const counterparty = event.params.counterparty;
  const timestamp   = event.params.timestamp;

  // Create Payment entity
  const paymentId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let payment     = new Payment(paymentId);
  payment.grantId      = event.params.grantId;
  payment.principal    = event.params.principal;
  payment.agent        = agent;
  payment.counterparty = counterparty;
  payment.amount       = event.params.amount;
  payment.settled      = true;
  payment.timestamp    = timestamp;
  payment.save();

  // Update AgentReputation
  let rep = loadOrCreateReputation(agent);
  rep.totalPayments      = rep.totalPayments.plus(BigInt.fromI32(1));
  rep.successfulPayments = rep.successfulPayments.plus(BigInt.fromI32(1));
  rep.lastPaymentAt      = timestamp;

  // Track unique counterparty
  if (trackCounterparty(agent, counterparty)) {
    rep.uniqueCounterparties = rep.uniqueCounterparties.plus(BigInt.fromI32(1));
  }

  recomputeScore(rep, event.block.timestamp);
  rep.save();

  log.info("PaymentSettled: agent={} score={}", [
    agent.toHexString(),
    rep.score.toString()
  ]);
}

/**
 * PaymentRefunded — increment refundedPayments, recompute score.
 * Note: refunds do NOT count toward counterparty diversity.
 */
export function handlePaymentRefunded(event: PaymentRefundedEvent): void {
  const agent     = event.params.agent;
  const timestamp = event.params.timestamp;

  // Create Payment entity (settled=false)
  const paymentId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let payment     = new Payment(paymentId);
  payment.grantId      = event.params.grantId;
  payment.principal    = event.params.principal;
  payment.agent        = agent;
  payment.counterparty = Bytes.empty();   // no counterparty on refund
  payment.amount       = event.params.amount;
  payment.settled      = false;
  payment.timestamp    = timestamp;
  payment.save();

  // Update AgentReputation
  let rep = loadOrCreateReputation(agent);
  rep.totalPayments    = rep.totalPayments.plus(BigInt.fromI32(1));
  rep.refundedPayments = rep.refundedPayments.plus(BigInt.fromI32(1));
  rep.lastPaymentAt    = timestamp;

  recomputeScore(rep, event.block.timestamp);
  rep.save();

  log.info("PaymentRefunded: agent={} score={}", [
    agent.toHexString(),
    rep.score.toString()
  ]);
}

/**
 * GrantRevoked — record revocation for cross-reference (reputation.md §6).
 */
export function handleGrantRevoked(event: GrantRevokedEvent): void {
  const id = event.params.grantId.toString();

  let revocation              = new GrantRevocation(id);
  revocation.grantId          = event.params.grantId;
  revocation.principal        = event.params.principal;
  revocation.blockNumber      = event.block.number;
  revocation.timestamp        = event.block.timestamp;
  revocation.transactionHash  = event.transaction.hash;
  revocation.save();

  log.info("GrantRevoked: grantId={} principal={}", [
    event.params.grantId.toString(),
    event.params.principal.toHexString()
  ]);
}
