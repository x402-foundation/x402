import type { CardanoSubmissionMode } from "./types";

/** Atomic claim for a canonical Cardano transaction. */
export interface CardanoSubmissionClaim {
  txHash: string;
  mode: CardanoSubmissionMode;
  ownerToken: string;
}

/** One atomic facilitator claim for transaction and optional Masumi terms. */
export interface CardanoSettlementClaim extends CardanoSubmissionClaim {
  termsDigest?: string;
}

/** Result of claiming a facilitator settlement. */
export type CardanoSettlementClaimResult =
  | "fresh"
  | "in-flight"
  | "submitted"
  | "rejected"
  | "mode-conflict"
  | "terms-conflict"
  | "capacity-exceeded";

/** Persistence boundary for facilitator transaction and Masumi-terms claims. */
export interface CardanoSettlementStore {
  claimSettlement(claim: CardanoSettlementClaim): Promise<CardanoSettlementClaimResult>;
  markSubmitted(txHash: string, ownerToken: string): Promise<void>;
  markRejected(txHash: string, ownerToken: string): Promise<void>;
}

interface SubmissionRecord extends CardanoSettlementClaim {
  inFlight: boolean;
  submitted: boolean;
  rejected: boolean;
}

/** Bounded process-local facilitator store for tests and disposable development. */
export class InMemoryCardanoSettlementStore implements CardanoSettlementStore {
  private readonly submissions = new Map<string, SubmissionRecord>();
  private readonly terms = new Map<string, { txHash: string }>();
  private readonly maxEntries: number;

  /**
   * Creates a bounded process-local settlement store.
   *
   * @param maxEntries - Combined submission and terms entry limit.
   */
  constructor(maxEntries = 4096) {
    this.maxEntries = positiveInteger(maxEntries, "maxEntries");
  }

  /**
   * Atomically claims one canonical transaction, submission mode and optional
   * Masumi terms digest. No partial terms binding is left on failure.
   *
   * @param claim - Transaction, mode and owner binding.
   * @returns The claim outcome.
   */
  async claimSettlement(claim: CardanoSettlementClaim): Promise<CardanoSettlementClaimResult> {
    const existingTerms = claim.termsDigest ? this.terms.get(claim.termsDigest) : undefined;
    if (existingTerms && existingTerms.txHash !== claim.txHash) return "terms-conflict";

    const existing = this.submissions.get(claim.txHash);
    if (existing) {
      if (existing.mode !== claim.mode) return "mode-conflict";
      if (existing.termsDigest !== claim.termsDigest) return "terms-conflict";
    }

    const requiredEntries = (existing ? 0 : 1) + (claim.termsDigest && !existingTerms ? 1 : 0);
    if (this.entryCount() + requiredEntries > this.maxEntries) return "capacity-exceeded";

    if (claim.termsDigest && !existingTerms) {
      this.terms.set(claim.termsDigest, { txHash: claim.txHash });
    }
    if (!existing) {
      this.submissions.set(claim.txHash, {
        txHash: claim.txHash,
        mode: claim.mode,
        ...(claim.termsDigest ? { termsDigest: claim.termsDigest } : {}),
        ownerToken: claim.ownerToken,
        inFlight: true,
        submitted: false,
        rejected: false,
      });
      return "fresh";
    }
    if (existing.rejected) return "rejected";
    return existing.inFlight ? "in-flight" : "submitted";
  }

  /**
   * Marks an owned transaction claim as submitted.
   *
   * @param txHash - Canonical transaction ID.
   * @param ownerToken - Claimant's owner token.
   */
  async markSubmitted(txHash: string, ownerToken: string): Promise<void> {
    const record = this.submissions.get(txHash);
    if (record?.ownerToken === ownerToken) {
      record.inFlight = false;
      record.submitted = true;
      record.rejected = false;
    }
  }

  /**
   * Permanently records a definitive pre-ledger rejection. Retaining this
   * tombstone prevents a paid retry from resubmitting the same invalid bytes.
   *
   * @param txHash - Canonical transaction ID.
   * @param ownerToken - Claimant's owner token.
   */
  async markRejected(txHash: string, ownerToken: string): Promise<void> {
    const record = this.submissions.get(txHash);
    if (record?.ownerToken === ownerToken) {
      record.inFlight = false;
      record.submitted = false;
      record.rejected = true;
    }
  }

  /**
   * Counts all retained records against the shared entry limit.
   *
   * @returns Combined number of retained terms and submission records.
   */
  private entryCount(): number {
    return this.submissions.size + this.terms.size;
  }
}

/**
 * Validates a positive safe integer setting.
 *
 * @param value - Candidate value.
 * @param name - Setting name used in errors.
 * @returns Validated value.
 */
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}
