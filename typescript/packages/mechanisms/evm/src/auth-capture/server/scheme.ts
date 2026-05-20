/**
 * AuthCapture Scheme - Server
 * Handles price parsing and requirement enhancement for resource servers.
 *
 * Implements x402's SchemeNetworkServer interface so it can be registered
 * on an x402ResourceServer via server.register('eip155:84532', new AuthCaptureEvmScheme()).
 */

import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";
import { convertToTokenAmount, numberToDecimalString } from "@x402/core/utils";
import { getDefaultAsset } from "../../shared/defaultAssets";
import { AUTH_CAPTURE_SCHEME } from "../constants";

/**
 * Validate a relative-offset extras key and resolve it to an absolute Unix
 * second. Returns `undefined` when the key is absent. Throws on a present-
 * but-invalid value so the merchant gets a clear error at the layer they
 * configured it, rather than a downstream facilitator rejection with a
 * cryptic reason.
 *
 * @param extras - Merged `extra` map being assembled for publication.
 * @param key - The relative-offset key to read (e.g. `"captureDeadlineSeconds"`).
 * @param now - Unix-second clock value used for the conversion.
 * @returns Absolute Unix-second deadline, or `undefined` if the key wasn't set.
 * @throws If `extras[key]` is present but not a finite positive number.
 */
function resolveOffsetToDeadline(
  extras: Record<string, unknown>,
  key: string,
  now: number,
): number | undefined {
  const raw = extras[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      `extra.${key} must be a positive finite number of seconds-from-now (got ${String(raw)})`,
    );
  }
  return now + raw;
}

/**
 * Field-specific hint appended to the missing-field error message for
 * fields whose configuration path is non-obvious. Keeps the merchant from
 * having to dig through docs to find out where the value comes from.
 */
const AUTH_CAPTURE_MERCHANT_FIELD_HINTS: Record<string, string> = {
  captureDeadline:
    " Set extra.captureDeadlineSeconds (relative, recommended) or extra.captureDeadline (absolute).",
  refundDeadline:
    " Set extra.refundDeadlineSeconds (relative, recommended) or extra.refundDeadline (absolute).",
};

/**
 * Assert that the merged `extra` carries every field that comes from the
 * merchant's route config, so a missing or wrongly-typed value surfaces as
 * a server-side error the merchant will see in their own logs rather than
 * as a downstream `invalid_auth_capture_extra` rejection from the facilitator.
 *
 * Asymmetric on purpose, matching upstream `batch-settlement`'s split: this
 * asserter covers fields the merchant directly sets in `accepts.extra`
 * (`captureAuthorizer`, deadlines, `feeRecipient`, fee bands), and skips
 * fields that `parsePrice` auto-populates from `getDefaultAsset` (`name`,
 * `version`). Those are handled separately:
 *  - For decimal pricing they're populated automatically and never missing.
 *  - For custom-AssetAmount pricing the merchant must set them on
 *    `AssetAmount.extra`; if they forget, the facilitator's
 *    `isAuthCaptureExtra` guard still rejects at verify time with
 *    `invalid_auth_capture_extra`. That's the right escalation point because
 *    the merchant has taken explicit control of the asset domain.
 *
 * @param extra - The merged `extra` map about to be returned by `enhancePaymentRequirements`.
 * @throws With a message naming the first missing or wrongly-typed merchant field, plus a path-to-fix hint where relevant.
 */
function assertAuthCaptureMerchantExtraComplete(extra: Record<string, unknown>): void {
  const required: Array<[string, "string" | "number"]> = [
    ["captureAuthorizer", "string"],
    ["captureDeadline", "number"],
    ["refundDeadline", "number"],
    ["feeRecipient", "string"],
    ["minFeeBps", "number"],
    ["maxFeeBps", "number"],
  ];
  for (const [key, expectedType] of required) {
    if (typeof extra[key] !== expectedType) {
      const hint = AUTH_CAPTURE_MERCHANT_FIELD_HINTS[key] ?? "";
      throw new Error(`AuthCapture requires extra.${key} (${expectedType}).${hint}`);
    }
  }
}

/**
 * Server-side implementation of the auth-capture scheme: maps merchant-friendly
 * prices (`"$0.01"`, decimal numbers, or pre-built `AssetAmount`) to the
 * stablecoin asset + base-unit amount needed in `PaymentRequirements`, resolves
 * merchant-supplied `*DeadlineSeconds` offsets into per-request absolute
 * deadlines, and merges facilitator-advertised `extra` fields into the
 * published requirements. Implements `SchemeNetworkServer`.
 */
export class AuthCaptureEvmScheme implements SchemeNetworkServer {
  readonly scheme = AUTH_CAPTURE_SCHEME;
  private moneyParsers: MoneyParser[] = [];

  /**
   * Add a custom money parser to the chain. Parsers run in registration order;
   * the first one to return a non-null `AssetAmount` wins. If every parser
   * returns null, the default network-stablecoin conversion is used.
   *
   * @param parser - Function that maps a decimal amount to an `AssetAmount`, or `null` to defer.
   * @returns This server scheme instance, for fluent chaining.
   */
  registerMoneyParser(parser: MoneyParser): AuthCaptureEvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Translate a merchant-supplied `Price` into a fully-resolved `AssetAmount`.
   * Pass-through for `AssetAmount` inputs (with required `asset` validation);
   * otherwise normalizes the input to a decimal, then runs the registered
   * money parser chain, falling back to the default stablecoin for the network.
   *
   * @param price - `"$0.01"` / `0.01` / `{ asset, amount }`.
   * @param network - CAIP-2 network identifier used for default-asset lookup.
   * @returns The resolved `AssetAmount` containing token address and base units.
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra || {},
      };
    }

    const numericAmount = this.parseMoneyToDecimal(price);

    for (const parser of this.moneyParsers) {
      const result = await parser(numericAmount, network);
      if (result !== null) {
        return result;
      }
    }

    return this.defaultMoneyConversion(numericAmount, network);
  }

  /**
   * Merge facilitator-advertised `extra` (from `/supported`) into the
   * merchant's payment requirements and resolve relative deadline offsets
   * into per-request absolute deadlines.
   *
   * auth-capture's wire format commits the payer to absolute Unix-second
   * `captureDeadline` and `refundDeadline` values in the on-chain
   * `PaymentInfo`. Merchants almost always think in policy terms
   * ("capture within 30 days, refund within 60 days"), so the server-side
   * convention is:
   *
   * - Merchant sets `extra.captureDeadlineSeconds` / `extra.refundDeadlineSeconds`
   *   (seconds-from-now relative offsets, matching x402's `maxTimeoutSeconds`
   *   suffix convention). These are server-side inputs only.
   * - `enhancePaymentRequirements` runs per request, computes
   *   `now + offset`, and publishes absolute `captureDeadline` /
   *   `refundDeadline` (the values the wire-format spec defines). The
   *   `*Seconds` keys are stripped from the published `extra`.
   * - Merchants who already have absolute timestamps (e.g., tied to an
   *   external commitment) can set `extra.captureDeadline` / `refundDeadline`
   *   directly; those values win over offset-derived ones.
   * - After offset conversion the merged `extra` is validated against the
   *   merchant-set subset of `isAuthCaptureExtra`: `captureAuthorizer`,
   *   `captureDeadline`, `refundDeadline`, `feeRecipient`, `minFeeBps`,
   *   `maxFeeBps`. Missing or wrongly-typed fields throw here so the
   *   merchant sees the error in their own logs rather than as a 402
   *   `invalid_auth_capture_extra` to a payer. `name` / `version` are
   *   excluded because `parsePrice` auto-populates them from
   *   `getDefaultAsset` for decimal pricing; the only path that bypasses
   *   that is a custom `AssetAmount` where the merchant has explicitly
   *   taken control of the asset domain, and the facilitator-side
   *   `isAuthCaptureExtra` rejection at verify time is the right
   *   escalation point for that case. Matches the asymmetric split
   *   `batch-settlement` uses (fail-fast on merchant-set fields, leave
   *   scheme-auto-populated fields to the wire).
   *
   * @param requirements - The merchant-authored payment requirements.
   * @param supportedKind - The facilitator's advertised support entry for this scheme/network.
   * @param supportedKind.x402Version - Protocol version the facilitator advertises.
   * @param supportedKind.scheme - Scheme identifier (`"auth-capture"`).
   * @param supportedKind.network - CAIP-2 network identifier.
   * @param supportedKind.extra - Facilitator-injected `extra` fields (lowest priority on collision).
   * @param _ - Unused list of facilitator extensions (interface compatibility).
   * @returns Enhanced `PaymentRequirements` with merged `extra` and resolved deadlines.
   */
  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    _: string[],
  ): Promise<PaymentRequirements> {
    const merged: Record<string, unknown> = {
      ...supportedKind.extra,
      ...requirements.extra,
    };

    const now = Math.floor(Date.now() / 1000);
    const captureFromOffset = resolveOffsetToDeadline(merged, "captureDeadlineSeconds", now);
    const refundFromOffset = resolveOffsetToDeadline(merged, "refundDeadlineSeconds", now);

    // Strip the server-side-only offset inputs; the wire format only carries absolute deadlines.
    delete merged.captureDeadlineSeconds;
    delete merged.refundDeadlineSeconds;

    // Absolute values (if the merchant supplied them directly) win over offset-derived ones.
    if (captureFromOffset !== undefined && typeof merged.captureDeadline !== "number") {
      merged.captureDeadline = captureFromOffset;
    }
    if (refundFromOffset !== undefined && typeof merged.refundDeadline !== "number") {
      merged.refundDeadline = refundFromOffset;
    }

    assertAuthCaptureMerchantExtraComplete(merged);

    return { ...requirements, extra: merged };
  }

  /**
   * Normalize a `Price` (string or number) to a decimal `number`. Strips `$`
   * and `,` formatting characters from strings before parsing.
   *
   * @param money - Decimal money expressed as a number or formatted string.
   * @returns The parsed decimal amount.
   * @throws If the string does not parse as a number.
   */
  private parseMoneyToDecimal(money: string | number): number {
    if (typeof money === "number") {
      return money;
    }
    const cleaned = String(money).replace(/[$,]/g, "").trim();
    const amount = parseFloat(cleaned);
    if (isNaN(amount)) {
      throw new Error(`Cannot parse price: ${money}`);
    }
    return amount;
  }

  /**
   * Fall-through converter: resolves a decimal amount against the default
   * stablecoin registered for the network in `getDefaultAsset` (shared with
   * the `exact` and `upto` schemes via `../../shared/defaultAssets`).
   * The EIP-712 token-domain fields (`name` / `version`) are included for
   * tokens used via ERC-3009 or EIP-2612 paths, and `assetTransferMethod` is
   * propagated for chains whose default token does not support ERC-3009.
   *
   * @param amount - Decimal amount in the token's display units.
   * @param network - CAIP-2 network identifier.
   * @returns Resolved `AssetAmount` with the network's default stablecoin.
   * @throws If no default stablecoin is configured for `network`.
   */
  private defaultMoneyConversion(amount: number, network: Network): AssetAmount {
    const assetInfo = getDefaultAsset(network);
    const tokenAmount = convertToTokenAmount(numberToDecimalString(amount), assetInfo.decimals);
    const includeEip712Domain = !assetInfo.assetTransferMethod || assetInfo.supportsEip2612;
    return {
      asset: assetInfo.address,
      amount: tokenAmount,
      extra: {
        ...(includeEip712Domain && {
          name: assetInfo.name,
          version: assetInfo.version,
        }),
        ...(assetInfo.assetTransferMethod && {
          assetTransferMethod: assetInfo.assetTransferMethod,
        }),
      },
    };
  }
}
