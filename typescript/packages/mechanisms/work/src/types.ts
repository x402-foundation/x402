import type { Network, PaymentRequirements, ResourceInfo } from "@x402/core/types";

export type WorkJob = {
  id: string;
  expiresAt: number;
  refreshAfter?: number;
  work: Record<string, unknown>;
};

export type WorkExtra = {
  name: "x402-work";
  version: "1";
  profile: string;
  job: WorkJob;
};

export type WorkIssueContext = {
  target: bigint;
  requirements: PaymentRequirements;
  resource: ResourceInfo;
  transportContext?: unknown;
};

export interface WorkJobIssuer {
  readonly profile: string;
  readonly asset: string;
  readonly networks: readonly Network[];
  issue(context: WorkIssueContext): Promise<WorkJob>;
}

export type WorkSolverContext = {
  target: bigint;
  requirements: PaymentRequirements;
  job: WorkJob;
  signal: AbortSignal;
};

export interface WorkSolver {
  readonly profile: string;
  solve(context: WorkSolverContext): Promise<Record<string, unknown>>;
}

export type WorkProfileInput = {
  network: Network;
  asset: string;
  amount: string;
  payTo: string;
  target: bigint;
  job: WorkJob;
  solution: Record<string, unknown>;
};

export type WorkProof = {
  score: bigint;
  extra?: Record<string, unknown>;
};

/**
 * Verifier for one work profile.
 *
 * The job in `input` comes from the client's `accepted` requirement. `verify`
 * MUST authenticate it as an issued job (retained source state, issuer
 * attestation, or a job-verification service) and MUST verify reward binding
 * to `payTo`. The scheme checks only the envelope, target, freshness, and replay.
 */
export interface WorkFacilitatorProfile {
  readonly profile: string;
  readonly asset: string;
  readonly networks: readonly Network[];
  /** Cheap, collision-resistant identifier of the computed work. Runs before `verify`. */
  fingerprint(input: WorkProfileInput): Promise<string> | string;
  /** Validates job, reward binding, solution, and proof, and returns the uint256 score. */
  verify(input: WorkProfileInput): Promise<WorkProof>;
}

export type WorkReservationState =
  | { status: "none" }
  | {
      status: "settled";
      binding: string;
    };

export type WorkConsumeResult = { status: "consumed" } | { status: "settled" | "conflict" };

/**
 * Replay store for consumed fingerprints. Production stores MUST be durable,
 * shared by every facilitator process, and make `consume` atomic.
 */
export interface WorkSettlementStore {
  inspect(fingerprint: string): Promise<WorkReservationState>;
  consume(fingerprint: string, binding: string): Promise<WorkConsumeResult>;
}

export type WorkServerOptions = {
  issuers: WorkJobIssuer[];
  now?: () => number;
};

export type WorkClientOptions = {
  solvers: WorkSolver[];
  now?: () => number;
};

export type WorkFacilitatorOptions = {
  profiles: WorkFacilitatorProfile[];
  store: WorkSettlementStore;
  caipFamily?: Network;
  now?: () => number;
};
