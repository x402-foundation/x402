import type {
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import { WORK_ASSET, WORK_SCHEME } from "../constants";
import type { WorkClientOptions, WorkSolver } from "../types";
import { parseWorkExtra, parseWorkSolution, remainingJobMs, targetForAmount } from "../utils";

/**
 * Client for the `work` scheme. Solves the issued job with the solver registered for its profile.
 */
export class WorkScheme implements SchemeNetworkClient {
  readonly scheme = WORK_SCHEME;
  private readonly solvers = new Map<string, WorkSolver>();
  private readonly now: () => number;

  /**
   * Creates a work client.
   *
   * @param options - Solvers, one per profile, and an optional clock
   */
  constructor(options: WorkClientOptions) {
    this.now = options.now ?? Date.now;
    for (const solver of options.solvers) {
      if (this.solvers.has(solver.profile))
        throw new Error(`duplicate work solver: ${solver.profile}`);
      this.solvers.set(solver.profile, solver);
    }
    if (this.solvers.size === 0) throw new Error("at least one work solver is required");
  }

  /**
   * Solves the job before `refreshAfter` (or `expiresAt`) and returns `{ solution }`.
   *
   * @param x402Version - Protocol version; must be 2
   * @param requirements - Selected work requirement
   * @returns Payment payload carrying the solution
   */
  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    if (
      x402Version !== 2 ||
      requirements.scheme !== WORK_SCHEME ||
      requirements.asset !== WORK_ASSET
    ) {
      throw new Error("work payments require x402 v2 and asset hash");
    }
    const extra = parseWorkExtra(requirements.extra);
    const solver = this.solvers.get(extra.profile);
    if (!solver) throw new Error(`no solver registered for ${extra.profile}`);
    const now = this.now();
    const remaining = remainingJobMs(extra.job, requirements.maxTimeoutSeconds, now);
    const solveFor = Math.min(
      remaining,
      (extra.job.refreshAfter ?? extra.job.expiresAt) * 1000 - now,
    );
    if (solveFor <= 0) throw new Error("work job refresh required");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("work job refresh required");
        controller.abort(error);
        reject(error);
      }, solveFor);
    });

    let solution: Record<string, unknown>;
    try {
      solution = await Promise.race([
        solver.solve({
          target: targetForAmount(requirements.amount),
          requirements,
          job: extra.job,
          signal: controller.signal,
        }),
        deadline,
      ]);
    } finally {
      clearTimeout(timer!);
    }
    const result = {
      x402Version,
      payload: { solution },
    };
    parseWorkSolution({ ...result, accepted: requirements });
    remainingJobMs(extra.job, requirements.maxTimeoutSeconds, this.now());
    if (extra.job.refreshAfter !== undefined && extra.job.refreshAfter * 1000 <= this.now()) {
      throw new Error("work job refresh required");
    }
    return result;
  }
}
