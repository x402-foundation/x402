import type { TrailRecord } from "../../types/trail_record.js";
import { computeActionRef, verifyTrailEvidence, verifyActionRef } from "./proof.js";

/**
 * In-memory trail store for reference implementation.
 *
 * In production, this would be backed by a tamper-evident storage layer
 * (e.g., Sigstore Transparency Log, append-only database).
 */
export class TrailStore {
  private records = new Map<string, TrailRecord>();

  /**
   * Store a trail record after verifying its integrity.
   * Returns true if the record was accepted, false if verification failed.
   */
  store(record: TrailRecord): boolean {
    if (!verifyTrailEvidence(record)) {
      return false;
    }
    if (!verifyActionRef(record)) {
      return false;
    }
    const key = `${record.payment_hash}:${record.action_ref}`;
    this.records.set(key, record);
    return true;
  }

  /**
   * Retrieve a trail record by payment_hash and action_ref.
   */
  get(payment_hash: string, action_ref: string): TrailRecord | undefined {
    const key = `${payment_hash}:${action_ref}`;
    return this.records.get(key);
  }

  /**
   * List all trail records associated with a payment_hash.
   */
  getByPaymentHash(payment_hash: string): TrailRecord[] {
    return Array.from(this.records.values()).filter(
      (r) => r.payment_hash === payment_hash
    );
  }

  /**
   * Verify a trail record exists and is externally anchored.
   */
  verify(payment_hash: string, action_ref: string): {
    exists: boolean;
    valid: boolean;
    record?: TrailRecord;
  } {
    const record = this.get(payment_hash, action_ref);
    if (!record) {
      return { exists: false, valid: false };
    }
    const valid = verifyTrailEvidence(record) && verifyActionRef(record);
    return { exists: true, valid, record };
  }
}
