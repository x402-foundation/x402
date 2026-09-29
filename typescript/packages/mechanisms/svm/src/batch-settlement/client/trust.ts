/**
 * Client-side trust policy for server-signed batch-settlement channels.
 *
 * In server mode the channel's onchain `authorized_signer` is the resource
 * operator, so the operator can sign a voucher for the full unspent deposit
 * without any further client signature. A client must therefore never enter
 * that mode because a 402 asked for it; it enters only for operator keys it
 * has decided to trust out of band, and only up to an escrow it chose.
 *
 * The policy mirrors the core `spendControls` shape: a USD cap that applies to
 * assets `findDefaultAsset` recognizes, and an opt-in list of other assets
 * with integer atomic caps. Trust is keyed by operator key alone, so it works
 * the same over HTTP, MCP, or any other transport.
 */

import type { Money, Network, PaymentRequirements } from "@x402/core/types";
import { convertToTokenAmount, networkMatchesPattern, parseMoney } from "@x402/core/utils";

import { findDefaultAsset } from "../../defaultAssets";
import { BATCH_SETTLEMENT_SCHEME } from "../types";

/** Default escrow cap for default assets under a trusted operator. */
export const DEFAULT_SERVER_SIGNED_MAX_DEPOSIT: Money = "$1";

/** Opt-in asset for {@link BatchServerSignedChannelsPolicy.allowedAssets}. */
export interface ServerSignedChannelsAsset {
  network: Network;
  /** On-chain mint, or a default-asset symbol (e.g. `"USDC"`). */
  asset: string;
  /** Optional integer atomic escrow cap (e.g. `"5000000"`), not `"$1"`. Omit to leave it uncapped. */
  maxDeposit?: string | undefined;
}

/**
 * Which operators may hold this client's voucher-signing authority, and how
 * much escrow it will lock under them.
 */
export interface BatchServerSignedChannelsPolicy {
  /**
   * Base58 operator keys this client trusts. A server-signed accept whose
   * `extra.operator` is not listed is refused and, when the same resource is
   * also offered client-signed, paid that way instead.
   */
  allowedOperators: readonly string[];
  /**
   * USD cap on the total escrow (deposit plus top-ups) locked in one channel
   * under a trusted operator, for assets `findDefaultAsset` recognizes. This is
   * the amount a dishonest operator could take, so server `minDeposit` hints
   * above it are clamped, not honored. `false` disables the cap.
   *
   * @default "$1"
   */
  maxDeposit?: Money | false | undefined;
  /**
   * Opt-in non-default assets, each with an optional integer atomic cap. A
   * server-signed accept for an asset that is neither a default asset nor
   * listed here is refused.
   */
  allowedAssets?: readonly ServerSignedChannelsAsset[] | undefined;
}

/** A matched grant, with the cap resolved to atomic units for the accept's asset. */
export interface ResolvedServerSignedTrust {
  operator: string;
  maxDeposit?: bigint | undefined;
}

/**
 * A server-signed accept this client will not act on. The scheme's
 * creation-failure hook recognizes it and falls back to the same resource's
 * client-signed accept when one is offered.
 */
export class UntrustedOperatorError extends Error {
  /**
   * Build the refusal with the operator it concerns, so a fallback can name it.
   *
   * @param message - Actionable explanation of the refusal
   * @param operator - The advertised operator key, when the accept carried one
   */
  constructor(
    message: string,
    readonly operator: string | undefined,
  ) {
    super(message);
    this.name = "UntrustedOperatorError";
  }
}

/**
 * Whether an accept asks the client to delegate voucher signing to the operator.
 *
 * @param accept - One entry of `PaymentRequired.accepts`
 * @returns True for a batch-settlement accept in server mode
 */
export function isServerSignedAccept(accept: PaymentRequirements): boolean {
  return accept.scheme === BATCH_SETTLEMENT_SCHEME && accept.extra?.voucherSigner === "server";
}

/**
 * Decides which server-signed accepts a client may act on, and up to what escrow.
 */
export class ServerSignedTrustPolicy {
  private readonly operators: ReadonlySet<string>;
  private readonly usdCap: string | false;
  private readonly assets: readonly ServerSignedChannelsAsset[];

  /**
   * Validate and normalize the configured policy.
   *
   * @param policy - `serverSignedChannelsPolicy`, or undefined to trust nobody
   */
  constructor(policy?: BatchServerSignedChannelsPolicy | undefined) {
    const label = "serverSignedChannelsPolicy";
    const operators = policy?.allowedOperators ?? [];
    operators.forEach((operator, index) => {
      if (typeof operator !== "string" || operator.length === 0) {
        throw new Error(`${label}.allowedOperators[${index}] must be a non-empty base58 key`);
      }
    });
    this.operators = new Set(operators);
    if (policy?.maxDeposit === false) {
      this.usdCap = false;
    } else {
      const money = policy?.maxDeposit ?? DEFAULT_SERVER_SIGNED_MAX_DEPOSIT;
      const { amount } = parseMoney(money);
      if (Number(amount) <= 0) throw new Error(`${label}.maxDeposit must be positive`);
      this.usdCap = amount;
    }
    this.assets = policy?.allowedAssets ?? [];
    this.assets.forEach((entry, index) => {
      if (entry.maxDeposit !== undefined && !/^[1-9]\d*$/.test(entry.maxDeposit)) {
        throw new Error(
          `${label}.allowedAssets[${index}].maxDeposit must be a positive integer atomic amount, not a dollar value; got ${JSON.stringify(entry.maxDeposit)}`,
        );
      }
    });
  }

  /**
   * The grant under which this client may pay a server-signed accept.
   *
   * @param requirements - Selected accept
   * @returns The operator and the atomic escrow cap for this accept's asset
   * @throws UntrustedOperatorError when the operator is not allowed or the asset is not permitted
   */
  grantFor(requirements: PaymentRequirements): ResolvedServerSignedTrust {
    const operator = requirements.extra?.operator;
    if (typeof operator !== "string" || !this.operators.has(operator)) {
      throw new UntrustedOperatorError(
        untrustedOperatorMessage(typeof operator === "string" ? operator : undefined),
        typeof operator === "string" ? operator : undefined,
      );
    }
    const defaultAsset = findDefaultAsset(requirements.asset, requirements.network);
    const entry = this.assets.find(
      candidate =>
        networkMatchesPattern(candidate.network, requirements.network) &&
        (candidate.asset.toLowerCase() === requirements.asset.toLowerCase() ||
          (defaultAsset !== undefined &&
            defaultAsset.symbol.toLowerCase() === candidate.asset.toLowerCase())),
    );
    if (entry) {
      return {
        operator,
        ...(entry.maxDeposit !== undefined ? { maxDeposit: BigInt(entry.maxDeposit) } : {}),
      };
    }
    if (!defaultAsset) {
      throw new UntrustedOperatorError(
        `batch-settlement: ${requirements.asset} on ${requirements.network} is not a default asset. ` +
          "Add it to serverSignedChannelsPolicy.allowedAssets with an atomic maxDeposit before " +
          `locking escrow under operator ${operator}.`,
        operator,
      );
    }
    if (this.usdCap === false) return { operator };
    return {
      operator,
      maxDeposit: BigInt(convertToTokenAmount(this.usdCap, defaultAsset.decimals)),
    };
  }

  /**
   * Filter a 402's accepts before payment selection.
   *
   * Server-signed accepts this client does not trust are removed, so the core
   * falls back to whatever else the server offered (typically the same route
   * in client mode). Trusted server-signed accepts are moved ahead of other
   * batch-settlement accepts on the same network so the default selector
   * picks metered pricing where the client has chosen to allow it. Accepts of
   * other schemes keep their positions.
   *
   * Usable directly as a core `PaymentPolicy`. Without it the scheme still
   * refuses untrusted accepts and falls back through its creation-failure
   * hook; this policy only adds the preference for trusted metered accepts.
   *
   * @param accepts - Offered payment requirements
   * @returns The filtered, reordered accepts
   * @throws UntrustedOperatorError when every accept required an untrusted operator
   */
  filterAccepts(accepts: readonly PaymentRequirements[]): PaymentRequirements[] {
    const trusted = new Set<PaymentRequirements>();
    const refused: string[] = [];
    const remaining = accepts.filter(accept => {
      if (!isServerSignedAccept(accept)) return true;
      try {
        this.grantFor(accept);
        trusted.add(accept);
        return true;
      } catch (error) {
        if (!(error instanceof UntrustedOperatorError)) throw error;
        refused.push(error.operator ?? "<missing>");
        return false;
      }
    });
    if (remaining.length === 0 && refused.length > 0) {
      throw new UntrustedOperatorError(untrustedOperatorMessage(...refused), refused[0]);
    }
    if (trusted.size === 0) return remaining;
    const reordered: PaymentRequirements[] = [];
    const networksSeen = new Set<string>();
    for (const accept of remaining) {
      if (accept.scheme === BATCH_SETTLEMENT_SCHEME && !networksSeen.has(accept.network)) {
        networksSeen.add(accept.network);
        for (const candidate of remaining) {
          if (
            candidate.scheme === BATCH_SETTLEMENT_SCHEME &&
            candidate.network === accept.network &&
            trusted.has(candidate)
          ) {
            reordered.push(candidate);
          }
        }
      }
      if (trusted.has(accept)) continue;
      reordered.push(accept);
    }
    return reordered;
  }
}

/**
 * Build the refusal message for an untrusted server-signed accept.
 *
 * @param operators - Operators the server advertised
 * @returns Human-readable, actionable error text
 */
export function untrustedOperatorMessage(...operators: readonly (string | undefined)[]): string {
  const keys = operators.filter((key): key is string => key !== undefined);
  const who = keys.length > 0 ? keys.join(", ") : "<unknown>";
  return (
    `batch-settlement: this resource requires a server-signed channel whose operator (${who}) ` +
    "can claim up to the full channel deposit without further client signatures. " +
    "Trust it explicitly by listing the key in serverSignedChannelsPolicy.allowedOperators, " +
    "and bound what it could take with serverSignedChannelsPolicy.maxDeposit."
  );
}
