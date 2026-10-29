import type {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemePaymentRequiredContext,
  SupportedKind,
} from "@x402/core/types";
import { WORK_ASSET, WORK_NAME, WORK_SCHEME, WORK_VERSION } from "../constants";
import type { WorkJobIssuer, WorkServerOptions } from "../types";
import {
  isProfileId,
  parseWorkExtra,
  parseWorkJob,
  remainingJobMs,
  supports,
  targetForAmount,
} from "../utils";

/**
 * Resource-server side of the `work` scheme. Issues a native job per 402 response.
 */
export class WorkScheme implements SchemeNetworkServer {
  readonly scheme = WORK_SCHEME;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    // Other flows add `extra.paymentFlow`, which the strict work `extra` does not allow.
    default: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  private readonly issuers = new Map<string, WorkJobIssuer>();
  private readonly now: () => number;

  /**
   * Creates a work server scheme.
   *
   * @param options - Job issuers, one per profile, and an optional clock
   */
  constructor(options: WorkServerOptions) {
    this.now = options.now ?? Date.now;
    for (const issuer of options.issuers) {
      if (!isProfileId(issuer.profile) || issuer.asset !== WORK_ASSET)
        throw new Error(`invalid work profile: ${issuer.profile}`);
      if (this.issuers.has(issuer.profile))
        throw new Error(`duplicate work issuer: ${issuer.profile}`);
      this.issuers.set(issuer.profile, issuer);
    }
    if (this.issuers.size === 0) throw new Error("at least one work issuer is required");
  }

  /**
   * Accepts only an explicit `{ amount, asset: "hash", extra: { profile } }` price.
   *
   * @param price - Route price
   * @param network - Route network
   * @returns Asset amount with the profile in `extra`
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price !== "object" || price === null || !("amount" in price)) {
      throw new Error("work payments require an explicit AssetAmount price");
    }
    const profile = price.extra?.profile;
    if (!isProfileId(profile)) throw new Error("work price requires extra.profile");
    const issuer = this.issuers.get(profile);
    if (!issuer) throw new Error(`no work issuer registered for ${profile}`);
    const result = {
      amount: price.amount,
      asset: price.asset,
      extra: { profile },
    };
    targetForAmount(result.amount);
    if (issuer.asset !== result.asset || !issuer.networks.includes(network)) {
      throw new Error(`${profile} does not support ${network} and ${result.asset}`);
    }
    return result;
  }

  /**
   * Confirms the facilitator supports the profile and sets the work `extra` envelope.
   *
   * @param requirements - Base requirement built from the route
   * @param supportedKind - Facilitator support for this scheme and network
   * @returns Requirement with `extra` set to name, version, and profile
   */
  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: SupportedKind,
  ): Promise<PaymentRequirements> {
    const profile = requirements.extra?.profile;
    if (!isProfileId(profile)) throw new Error("work requirements require extra.profile");
    const issuer = this.issuers.get(profile);
    if (!issuer || !supports(issuer, requirements)) {
      throw new Error(`${profile} does not support this work requirement`);
    }
    const profiles = supportedProfiles(supportedKind, requirements.network);
    if (!profiles.includes(profile)) {
      throw new Error(`facilitator does not support ${profile} on ${requirements.network}`);
    }
    return {
      ...requirements,
      extra: { name: WORK_NAME, version: WORK_VERSION, profile },
    };
  }

  /**
   * Validates the facilitator's advertised work support.
   *
   * @param network - Network to check
   * @param supportedKind - Facilitator support for this scheme and network
   * @returns An error message, or nothing when support is valid
   */
  validateFacilitatorSupport(network: Network, supportedKind: SupportedKind): string | void {
    try {
      supportedProfiles(supportedKind, network);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Attaches a job to each work requirement. On a paid retry, the accepted job is
   * reused. Offers whose issuer fails are omitted.
   *
   * @param context - 402 response context
   * @returns Requirements with jobs attached
   */
  async enrichPaymentRequiredResponse(
    context: SchemePaymentRequiredContext,
  ): Promise<PaymentRequirements[]> {
    const accepted = context.paymentPayload?.accepted;
    let resumed = false;
    let acceptedExtra: ReturnType<typeof parseWorkExtra> | undefined;
    if (accepted?.scheme === WORK_SCHEME) {
      try {
        acceptedExtra = parseWorkExtra(accepted.extra);
        remainingJobMs(acceptedExtra.job, accepted.maxTimeoutSeconds, this.now());
      } catch {
        acceptedExtra = undefined;
      }
    }

    const enriched: PaymentRequirements[] = [];
    for (const requirements of context.requirements) {
      if (requirements.scheme !== WORK_SCHEME || requirements.extra.job !== undefined) {
        enriched.push(requirements);
        continue;
      }
      if (
        !resumed &&
        accepted &&
        acceptedExtra &&
        sameOffer(requirements, accepted, acceptedExtra.profile)
      ) {
        const issuer = this.issuers.get(acceptedExtra.profile);
        if (issuer && supports(issuer, accepted)) {
          enriched.push({ ...accepted, extra: acceptedExtra });
          resumed = true;
          continue;
        }
      }
      try {
        const profile = requirements.extra.profile;
        if (!isProfileId(profile)) throw new Error("work requirements require extra.profile");
        const issuer = this.issuers.get(profile);
        if (!issuer || !supports(issuer, requirements)) {
          throw new Error(`no work issuer for ${profile} on ${requirements.network}`);
        }
        const job = parseWorkJob(
          await issuer.issue({
            target: targetForAmount(requirements.amount),
            requirements,
            resource: context.resourceInfo,
            transportContext: context.transportContext,
          }),
        );
        remainingJobMs(job, requirements.maxTimeoutSeconds, this.now());
        const extra = { name: WORK_NAME, version: WORK_VERSION, profile, job };
        parseWorkExtra(extra);
        enriched.push({ ...requirements, extra });
      } catch {
        // Omit only the unavailable work offer; other schemes and profiles remain usable.
      }
    }
    if (enriched.length === 0) {
      throw new Error("no work profile could issue a payment requirement");
    }
    return enriched;
  }
}

/**
 * Tests whether an accepted requirement has the same route terms as an offer.
 *
 * @param requirement - Route requirement without a job
 * @param accepted - Client-accepted requirement
 * @param profile - Accepted profile
 * @returns Whether the terms match
 */
function sameOffer(
  requirement: PaymentRequirements,
  accepted: PaymentRequirements,
  profile: string,
): boolean {
  return (
    requirement.scheme === accepted.scheme &&
    requirement.network === accepted.network &&
    requirement.asset === accepted.asset &&
    requirement.amount === accepted.amount &&
    requirement.payTo === accepted.payTo &&
    requirement.maxTimeoutSeconds === accepted.maxTimeoutSeconds &&
    requirement.extra.profile === profile
  );
}

/**
 * Reads the profiles a facilitator advertises for a network.
 *
 * @param kind - Facilitator support entry
 * @param network - Network to check
 * @returns Advertised profile identifiers
 */
function supportedProfiles(kind: SupportedKind, network: Network): string[] {
  if (
    kind.x402Version !== 2 ||
    kind.scheme !== WORK_SCHEME ||
    kind.network !== network ||
    kind.extra?.name !== WORK_NAME ||
    kind.extra?.version !== WORK_VERSION ||
    !Array.isArray(kind.extra?.profiles) ||
    kind.extra.profiles.some(profile => !isProfileId(profile))
  ) {
    throw new Error(`facilitator advertised invalid work support for ${network}`);
  }
  return kind.extra.profiles as string[];
}
