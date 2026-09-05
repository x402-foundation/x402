/**
 * Canton resource-server (merchant) implementation of the `exact` scheme.
 *
 * Declares the payment flow, validates that the merchant's advertised
 * `asset`/`extra.instrumentId` are consistent, and merges the facilitator's
 * `feePayer` + `synchronizerId` (from /supported) into the 402 challenge.
 */
import type {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { CANTON_TRANSFER_METHOD } from "../../constants.js";
import { findDefaultAsset } from "../../defaultAssets.js";

/** Options for the Canton server scheme (none currently). */
export type ExactCantonServerOptions = Record<string, never>;

/** Server-side `exact` scheme for Canton networks. */
export class ExactCantonScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = CANTON_TRANSFER_METHOD;
  readonly paymentFlows = {
    [CANTON_TRANSFER_METHOD]: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  // Injected by the facilitator into the 402 `extra` (see enhancePaymentRequirements),
  // so they are excluded from the requirements-vs-accepted match.
  readonly dynamicExtraFields = ["feePayer", "synchronizerId"];

  /**
   * Decimals for a known default asset (Canton Coin = 1e10), or undefined.
   *
   * @param asset - Asset symbol or structured id.
   * @param network - The Canton network.
   * @returns The asset's decimals, or undefined when not a known default.
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
  }

  /**
   * Canton prices are explicit `AssetAmount`s (`{ amount: "<atomic>", asset }`);
   * a bare money string ("$0.10") has no Canton Coin peg and is not supported.
   *
   * @param price - The merchant's price; must be an AssetAmount.
   * @param network - The Canton network (for error context).
   * @returns The asset amount to quote.
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset must be specified for an AssetAmount on network ${network}`);
      }
      return { amount: price.amount, asset: price.asset, extra: price.extra ?? {} };
    }
    throw new Error(
      `The Canton exact scheme requires an explicit AssetAmount price ` +
        `({ amount: "<atomic units>", asset: "CC" | "<registry symbol>" }); ` +
        `dollar-string pricing has no Canton Coin peg.`,
    );
  }

  /**
   * Merge the facilitator's advertised `feePayer` + `synchronizerId` into the
   * 402 challenge, and assert asset/instrumentId consistency.
   *
   * @param paymentRequirements - The merchant's base requirements.
   * @param supportedKind - The facilitator's advertised kind (carries the extra).
   * @param facilitatorExtensions - Facilitator extension keys (unused here).
   * @returns The enhanced requirements sent to clients.
   */
  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    void facilitatorExtensions;
    const extra: Record<string, unknown> = {
      assetTransferMethod: CANTON_TRANSFER_METHOD,
      ...paymentRequirements.extra,
    };
    // feePayer + synchronizerId come from the facilitator's /supported (getExtra).
    if (supportedKind.extra?.feePayer !== undefined) {
      extra.feePayer = supportedKind.extra.feePayer;
    }
    if (extra.synchronizerId === undefined && supportedKind.extra?.synchronizerId !== undefined) {
      extra.synchronizerId = supportedKind.extra.synchronizerId;
    }
    const enhanced = { ...paymentRequirements, extra };
    assertAssetInstrumentConsistency(enhanced);
    return enhanced;
  }
}

/**
 * A structured `asset` of the `<admin>::<id>` form must agree with
 * `extra.instrumentId`. The facilitator validates against `instrumentId` and
 * ignores `asset`, so a silent disagreement would settle the wrong instrument.
 * A symbolic asset (e.g. "CC") is not cross-checked.
 *
 * @param req - The payment requirements to check.
 * @throws When a structured `asset` disagrees with `extra.instrumentId`.
 */
export function assertAssetInstrumentConsistency(req: PaymentRequirements): void {
  const inst = (req.extra as { instrumentId?: { admin: string; id: string } }).instrumentId;
  if (!inst) return;
  if (!req.asset.includes("::")) return;
  const expected = `${inst.admin}::${inst.id}`;
  if (req.asset !== expected) {
    throw new Error(
      `payment requirements asset "${req.asset}" disagrees with extra.instrumentId ` +
        `("${expected}"). On Canton the instrumentId is authoritative — make them consistent.`,
    );
  }
}
