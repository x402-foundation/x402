import type { PaymentRequirements } from "@x402/core/types";
import type { BatchSettlePayload } from "../types";

/** An immutable distribution request retained until its facilitator confirms success. */
export interface DistributionJob {
  version: 1;
  id: string;
  channels: BatchSettlePayload["channels"];
  requirements: PaymentRequirements;
}

/**
 * Journal for one redemption owner. Production restart recovery requires durable storage.
 * List must include every saved, undeleted job, including writes whose acknowledgement
 * was lost. Save must persist before returning and must not replace an existing ID;
 * identical retries may succeed. Delete removes only that globally unique generation.
 * Eventually consistent enumeration is insufficient. Ownership must be coordinated
 * externally when multiple workers can use this journal.
 */
export interface DistributionJobStore {
  list(): Promise<DistributionJob[]>;
  save(job: DistributionJob): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Clone the JSON wire representation, rejecting values a durable journal cannot preserve.
 *
 * @param job - Request snapshot to normalize
 * @returns Detached JSON-compatible job
 */
export function cloneDistributionJob(job: DistributionJob): DistributionJob {
  const ancestors = new Set<object>();
  const validate = (value: unknown): void => {
    if (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (
      typeof value !== "object" ||
      (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    )
      throw new Error("distribution jobs require JSON-compatible values");
    if (ancestors.has(value)) throw new Error("distribution jobs cannot contain cycles");
    ancestors.add(value);
    for (const child of Object.values(value)) validate(child);
    ancestors.delete(value);
  };
  validate(job);
  return JSON.parse(JSON.stringify(job)) as DistributionJob;
}

/** Memory-only journal; share it explicitly when recreating a manager in one process. */
export class MemoryDistributionJobStore implements DistributionJobStore {
  private readonly jobs = new Map<string, DistributionJob>();

  /** @inheritdoc */
  async list(): Promise<DistributionJob[]> {
    return [...this.jobs.values()].map(cloneDistributionJob);
  }

  /** @inheritdoc */
  async save(job: DistributionJob): Promise<void> {
    const snapshot = cloneDistributionJob(job);
    // Stable object-key ordering makes identical JSON retries idempotent.
    const canonical = (value: DistributionJob) =>
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      );
    const previous = this.jobs.get(job.id);
    if (previous && canonical(previous) !== canonical(snapshot)) {
      throw new Error("distribution job ID already exists");
    }
    this.jobs.set(job.id, snapshot);
  }

  /** @inheritdoc */
  async delete(id: string): Promise<void> {
    this.jobs.delete(id);
  }
}
