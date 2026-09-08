/** One atomic facilitator claim for a canonical transaction and optional Masumi terms. */
export interface CardanoSettlementClaim {
  txHash: string;
  ownerToken: string;
  termsDigest?: string;
}

/** Result of claiming a facilitator settlement. */
export type CardanoSettlementClaimResult =
  | "fresh"
  | "in-flight"
  | "submitted"
  | "rejected"
  | "terms-conflict"
  | "capacity-exceeded";

/**
 * Duplicate-settlement guard shared by every facilitator worker.
 *
 * Keyed by the canonical Cardano transaction id, it makes sure one transaction
 * is broadcast at most once and lets a retry for the same transaction resume
 * observing it. The default {@link InMemoryCardanoSettlementStore} is process
 * local; a multi-instance facilitator should supply a shared, atomically
 * updating implementation (Redis/Valkey, SQL, ...) instead.
 */
export interface CardanoSettlementStore {
  claimSettlement(claim: CardanoSettlementClaim): Promise<CardanoSettlementClaimResult>;
  markSubmitted(txHash: string, ownerToken: string): Promise<void>;
  markRejected(txHash: string, ownerToken: string): Promise<void>;
  /**
   * Gives up a fresh claim before anything was broadcast (verification failed
   * after the claim was taken), so a later attempt for the same transaction
   * starts over. MUST be a no-op unless the caller owns the claim and it is
   * still mid-submission.
   */
  releaseClaim(txHash: string, ownerToken: string): Promise<void>;
}

interface SubmissionRecord extends CardanoSettlementClaim {
  inFlight: boolean;
  submitted: boolean;
  rejected: boolean;
}

/** Default capacity of {@link InMemoryCardanoSettlementStore}. */
export const DEFAULT_SETTLEMENT_STORE_ENTRIES = 4096;

/**
 * Bounded process-local settlement store, the facilitator default.
 *
 * Once full it evicts the oldest record that is no longer in flight (a claim
 * that was broadcast or definitively rejected), together with the Masumi terms
 * binding that record holds. Evicting a settled claim is safe for a
 * single-process facilitator: the node itself refuses to re-apply a transaction
 * whose inputs are already spent, and the resource server binds Masumi terms to
 * their first transaction independently. Only when every retained record is
 * still mid-submission does a claim report `capacity-exceeded`.
 */
export class InMemoryCardanoSettlementStore implements CardanoSettlementStore {
  private readonly submissions = new Map<string, SubmissionRecord>();
  private readonly terms = new Map<string, { txHash: string }>();
  private readonly maxEntries: number;

  /**
   * Creates a bounded process-local settlement store.
   *
   * @param maxEntries - Combined submission and terms entry limit.
   */
  constructor(maxEntries = DEFAULT_SETTLEMENT_STORE_ENTRIES) {
    this.maxEntries = positiveInteger(maxEntries, "maxEntries");
  }

  /**
   * Atomically claims one canonical transaction and optional Masumi terms
   * digest. No partial terms binding is left on failure.
   *
   * @param claim - Transaction and owner binding.
   * @returns The claim outcome.
   */
  async claimSettlement(claim: CardanoSettlementClaim): Promise<CardanoSettlementClaimResult> {
    const existingTerms = claim.termsDigest ? this.terms.get(claim.termsDigest) : undefined;
    if (existingTerms && existingTerms.txHash !== claim.txHash) return "terms-conflict";

    const existing = this.submissions.get(claim.txHash);
    if (existing) {
      if (existing.termsDigest !== claim.termsDigest) return "terms-conflict";
      if (existing.rejected) return "rejected";
      return existing.inFlight ? "in-flight" : "submitted";
    }

    const requiredEntries = 1 + (claim.termsDigest && !existingTerms ? 1 : 0);
    while (this.entryCount() + requiredEntries > this.maxEntries) {
      if (!this.evictOldestSettled()) return "capacity-exceeded";
    }

    if (claim.termsDigest && !existingTerms) {
      this.terms.set(claim.termsDigest, { txHash: claim.txHash });
    }
    this.submissions.set(claim.txHash, {
      txHash: claim.txHash,
      ...(claim.termsDigest ? { termsDigest: claim.termsDigest } : {}),
      ownerToken: claim.ownerToken,
      inFlight: true,
      submitted: false,
      rejected: false,
    });
    return "fresh";
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
   * Releases an owned, still-in-flight claim together with the terms binding
   * it took, as if it had never been made.
   *
   * @param txHash - Canonical transaction ID.
   * @param ownerToken - Claimant's owner token.
   */
  async releaseClaim(txHash: string, ownerToken: string): Promise<void> {
    const record = this.submissions.get(txHash);
    if (!record || record.ownerToken !== ownerToken || !record.inFlight) return;
    this.submissions.delete(txHash);
    if (record.termsDigest && this.terms.get(record.termsDigest)?.txHash === txHash) {
      this.terms.delete(record.termsDigest);
    }
  }

  /**
   * Drops the oldest record that is no longer mid-submission, plus the terms
   * binding it owns. `Map` preserves insertion order, so the first match is
   * the oldest settled claim.
   *
   * @returns Whether a record was evicted.
   */
  private evictOldestSettled(): boolean {
    for (const [txHash, record] of this.submissions) {
      if (record.inFlight) continue;
      this.submissions.delete(txHash);
      if (record.termsDigest && this.terms.get(record.termsDigest)?.txHash === txHash) {
        this.terms.delete(record.termsDigest);
      }
      return true;
    }
    return false;
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
