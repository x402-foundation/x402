/**
 * Pure, network-free helpers for the TaskMarket example client.
 *
 * Kept separate from index.ts so the spending-limit guard and payload
 * builders can be unit tested without mocking HTTP requests or wallet
 * signing.
 */

import { randomUUID } from "node:crypto";

/** Number of decimals TaskMarket's USDC amounts use (Base mainnet USDC). */
export const USDC_DECIMALS = 6;

/**
 * Header TaskMarket requires on every `POST /tasks`. Without it the API
 * returns 400 `idempotency_key_required` before the request ever reaches
 * the x402 payment flow.
 */
export const IDEMPOTENCY_KEY_HEADER = "X-Taskmarket-Idempotency-Key";

/**
 * Generates a fresh idempotency key for a single `POST /tasks` call. Call
 * this once per create invocation, not once per retry, so retries of the
 * same logical request stay idempotent on TaskMarket's side.
 *
 * @returns a random v4 UUID string
 */
export function createIdempotencyKey(): string {
  return randomUUID();
}

/**
 * Builds the headers for TaskMarket's `POST /tasks`, including the
 * required idempotency key.
 *
 * @param idempotencyKey - a fresh UUID for this create invocation
 * @returns headers to send with the create-task request
 */
export function buildCreateTaskHeaders(idempotencyKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
  };
}

/**
 * Converts a human-entered USD amount into the atomic USDC units
 * TaskMarket's API expects.
 *
 * @param usd - decimal USD string, e.g. "2.50", up to 6 fractional digits
 * @returns atomic unit string matching TaskMarket's `^[0-9]+$` reward pattern
 */
export function usdToAtomicUnits(usd: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(usd)) {
    throw new Error(`Invalid USD amount: "${usd}". Expected a plain decimal like "2.50".`);
  }
  const [whole, fraction = ""] = usd.split(".");
  const paddedFraction = fraction.padEnd(USDC_DECIMALS, "0");
  const atomic = `${whole}${paddedFraction}`.replace(/^0+(?=\d)/, "");
  return atomic;
}

/**
 * Converts atomic USDC units back into a human-readable USD string.
 *
 * @param atomic - atomic unit string, e.g. "2500000"
 * @returns decimal USD string, e.g. "2.50"
 */
export function atomicUnitsToUsd(atomic: string): string {
  if (!/^\d+$/.test(atomic)) {
    throw new Error(`Invalid atomic amount: "${atomic}".`);
  }
  const padded = atomic.padStart(USDC_DECIMALS + 1, "0");
  const whole = padded.slice(0, -USDC_DECIMALS).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-USDC_DECIMALS);
  return `${whole}.${fraction}`;
}

/** Thrown when a requested task reward exceeds the configured spending cap. */
export class SpendingLimitExceededError extends Error {
  /**
   * Builds the error message from the reward and cap.
   *
   * @param rewardAtomic - the reward that was requested, in atomic units
   * @param capAtomic - the configured maximum, in atomic units
   */
  constructor(
    public readonly rewardAtomic: string,
    public readonly capAtomic: string,
  ) {
    super(
      `Task reward ${atomicUnitsToUsd(rewardAtomic)} USDC exceeds the configured spending ` +
        `limit of ${atomicUnitsToUsd(capAtomic)} USDC (MAX_TASK_REWARD_USDC). Refusing to create the task.`,
    );
    this.name = "SpendingLimitExceededError";
  }
}

/**
 * Throws if a task reward exceeds the caller-configured spending cap. This
 * is the only guard between a user's --reward flag and a real on-chain USDC
 * transfer, so it fails closed: a missing or malformed cap authorizes
 * nothing rather than falling back to "no limit".
 *
 * @param rewardAtomic - task reward the user asked to create, in atomic units
 * @param capAtomic - configured maximum spend, in atomic units
 */
export function assertWithinSpendingLimit(rewardAtomic: string, capAtomic: string): void {
  if (BigInt(rewardAtomic) > BigInt(capAtomic)) {
    throw new SpendingLimitExceededError(rewardAtomic, capAtomic);
  }
}

/** Discovery filters accepted by the `list` command, mapped to TaskMarket's `GET /tasks` query params. */
export interface TaskListFilters {
  mode?: "bounty" | "claim" | "pitch" | "benchmark" | "auction";
  status?:
    | "open"
    | "claimed"
    | "worker_selected"
    | "pending_approval"
    | "review"
    | "completed"
    | "expired"
    | "cancelled"
    | "ALL";
  minReward?: string;
  maxReward?: string;
  tags?: string[];
  limit?: number;
  sort?: "newest" | "reward_desc" | "reward_asc" | "deadline_asc";
}

/**
 * Builds the query string for TaskMarket's `GET /tasks` discovery endpoint.
 *
 * @param filters - discovery filters supplied on the command line
 * @returns URLSearchParams ready to append to the tasks endpoint
 */
export function buildTaskListParams(filters: TaskListFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.mode) params.set("mode", filters.mode);
  if (filters.status) params.set("status", filters.status);
  if (filters.minReward) params.set("minReward", filters.minReward);
  if (filters.maxReward) params.set("maxReward", filters.maxReward);
  if (filters.tags?.length) params.set("tags", filters.tags.join(","));
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.sort) params.set("sort", filters.sort);
  return params;
}

/** Validated fields for creating a bounty task. */
export interface CreateTaskInput {
  description: string;
  rewardAtomic: string;
  durationSeconds: number;
  tags: string[];
}

/**
 * Builds the JSON body for TaskMarket's `POST /tasks` (X402 required),
 * validating the fields TaskMarket's API marks required.
 *
 * @param input - task fields collected from the CLI
 * @returns the request body TaskMarket's create-task endpoint expects
 */
export function buildCreateTaskBody(input: CreateTaskInput): Record<string, unknown> {
  if (!input.description.trim()) {
    throw new Error("description must not be empty");
  }
  if (!input.tags.length) {
    throw new Error("at least one tag is required");
  }
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
    throw new Error("durationSeconds must be a positive number");
  }
  if (!/^[0-9]+$/.test(input.rewardAtomic) || BigInt(input.rewardAtomic) <= 0n) {
    throw new Error("rewardAtomic must be a positive integer string");
  }
  return {
    description: input.description,
    reward: input.rewardAtomic,
    duration: input.durationSeconds,
    tags: input.tags,
    mode: "bounty",
  };
}
