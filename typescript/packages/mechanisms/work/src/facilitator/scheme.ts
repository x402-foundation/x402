import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { WORK_NAME, WORK_SCHEME, WORK_VERSION } from "../constants";
import type {
  WorkFacilitatorOptions,
  WorkFacilitatorProfile,
  WorkProfileInput,
  WorkProof,
} from "../types";
import {
  isProfileId,
  parseWorkExtra,
  parseWorkSolution,
  remainingJobMs,
  supports,
  uint256Hex,
  validateEnvelope,
  validateFingerprint,
  validateScore,
  workBinding,
  workInput,
} from "../utils";

type ValidatedWork = {
  profile: WorkFacilitatorProfile;
  input: WorkProfileInput;
  proof: WorkProof;
  fingerprint: string;
  binding: string;
};

/**
 * Facilitator side of the `work` scheme. Verifies proofs and consumes fingerprints.
 */
export class WorkScheme implements SchemeNetworkFacilitator {
  readonly scheme = WORK_SCHEME;
  readonly caipFamily: Network;
  private readonly profiles = new Map<string, WorkFacilitatorProfile>();
  private readonly now: () => number;

  /**
   * Creates a work facilitator scheme.
   *
   * @param options - Profiles, replay store, CAIP family, and an optional clock
   */
  constructor(private readonly options: WorkFacilitatorOptions) {
    this.caipFamily = options.caipFamily ?? "*:*";
    this.now = options.now ?? Date.now;
    for (const profile of options.profiles) {
      if (!isProfileId(profile.profile) || profile.asset !== "hash")
        throw new Error(`invalid work profile: ${profile.profile}`);
      if (this.profiles.has(profile.profile)) {
        throw new Error(`duplicate work profile: ${profile.profile}`);
      }
      this.profiles.set(profile.profile, profile);
    }
    if (this.profiles.size === 0) throw new Error("at least one work profile is required");
  }

  /**
   * Advertises the profiles served on a network.
   *
   * @param network - Network to describe
   * @returns Work `extra` with sorted profile identifiers
   */
  getExtra(network: Network): Record<string, unknown> {
    const profiles = [...this.profiles.values()]
      .filter(profile => profile.networks.includes(network))
      .map(profile => profile.profile)
      .sort();
    return { name: WORK_NAME, version: WORK_VERSION, profiles };
  }

  /**
   * Work settlement signs nothing.
   *
   * @param _ - Network (unused)
   * @returns An empty list
   */
  getSigners(_: string): string[] {
    return [];
  }

  /**
   * Verifies a solution without consuming or submitting it.
   *
   * @param payload - Client payment payload
   * @param requirements - Requirement to verify against
   * @returns Verification result with proof metadata
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const result = await this.validateAndProve(payload, requirements);
    if ("invalid" in result) return result.invalid;
    return {
      isValid: true,
      extra: proofMetadata(result),
    };
  }

  /**
   * Re-verifies the solution and atomically consumes its fingerprint.
   *
   * @param payload - Client payment payload
   * @param requirements - Requirement to settle against
   * @returns Settlement whose `transaction` is the fingerprint
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const work = await this.validateAndProve(payload, requirements);
    if ("invalid" in work) return failedSettlement(requirements, work.invalid);

    const consumed = await this.options.store.consume(work.fingerprint, work.binding);
    if (consumed.status !== "consumed") {
      return failedSettlement(
        requirements,
        invalidWork(`invalid_work_${consumed.status}`, "work is already consumed"),
      );
    }

    return {
      success: true,
      transaction: work.fingerprint,
      network: requirements.network,
      amount: requirements.amount,
      extra: proofMetadata(work),
    };
  }

  /**
   * Runs envelope, freshness, fingerprint, replay, and proof checks in cost order.
   *
   * @param payload - Client payment payload
   * @param requirements - Requirement to check against
   * @returns Validated work, or the verification failure
   */
  private async validateAndProve(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<ValidatedWork | { invalid: VerifyResponse }> {
    try {
      validateEnvelope(payload, requirements);
      const extra = parseWorkExtra(requirements.extra);
      const profile = this.profiles.get(extra.profile);
      if (!profile || !supports(profile, requirements)) {
        return { invalid: invalidWork("invalid_work_profile") };
      }
      if (extra.job.expiresAt <= Math.floor(this.now() / 1000)) {
        return { invalid: invalidWork("invalid_work_stale") };
      }
      remainingJobMs(extra.job, requirements.maxTimeoutSeconds, this.now());
      const input = workInput(requirements, extra, parseWorkSolution(payload));
      const fingerprint = validateFingerprint(await profile.fingerprint(input));
      const binding = workBinding(requirements, extra);
      const state = await this.options.store.inspect(fingerprint);
      if (state.status === "settled") {
        return { invalid: invalidWork("invalid_work_state") };
      }

      const proof = await profile.verify(input);
      validateScore(proof.score);
      if (proof.score > input.target) return { invalid: invalidWork("invalid_work_target") };
      if (extra.job.expiresAt <= Math.floor(this.now() / 1000)) {
        return { invalid: invalidWork("invalid_work_stale") };
      }

      return { profile, input, proof, fingerprint, binding };
    } catch (error) {
      return {
        invalid: invalidWork(
          "invalid_work_payload",
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  }
}

/**
 * Builds a failed verification response.
 *
 * @param reason - Stable error reason
 * @param message - Optional detail
 * @returns Failed verification response
 */
function invalidWork(reason: string, message?: string): VerifyResponse {
  return {
    isValid: false,
    invalidReason: reason,
    ...(message ? { invalidMessage: message } : {}),
  };
}

/**
 * Converts a failed verification into a failed settlement.
 *
 * @param requirements - Requirement being settled
 * @param verification - Failed verification
 * @returns Failed settlement response
 */
function failedSettlement(
  requirements: PaymentRequirements,
  verification: VerifyResponse,
): SettleResponse {
  return {
    success: false,
    transaction: "",
    network: requirements.network,
    errorReason: verification.invalidReason ?? "invalid_work",
    errorMessage: verification.invalidMessage,
  };
}

/**
 * Builds verify and settle `extra`. Drops any profile `sourceAccepted`, which only
 * the provider may report after native submission.
 *
 * @param work - Validated work
 * @returns Proof metadata
 */
function proofMetadata(work: ValidatedWork): Record<string, unknown> {
  const extra = { ...work.proof.extra };
  delete extra.sourceAccepted;
  return {
    ...extra,
    profile: work.profile.profile,
    jobId: work.input.job.id,
    score: uint256Hex(work.proof.score),
    fingerprint: work.fingerprint,
  };
}
