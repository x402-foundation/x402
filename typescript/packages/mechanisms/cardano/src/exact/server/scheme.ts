import type {
  AssetAmount,
  Money,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemePaymentRequiredContext,
  SchemeNetworkServer,
  SchemeServerHooks,
  SupportedKind,
} from "@x402/core/types";
import { convertToTokenAmount, deepEqual, parseMoney } from "@x402/core/utils";
import {
  ASSET_TRANSFER_METHOD_DEFAULT,
  ASSET_TRANSFER_METHOD_MASUMI,
  ASSET_TRANSFER_METHOD_SCRIPT,
  CANONICAL_CARDANO_ASSET_REGEX,
  ERR_DUPLICATE_SETTLEMENT,
  ERR_INVALID_PAYLOAD,
  ERR_MASUMI_TERMS_MISMATCH,
  ERR_MASUMI_TERMS_UNKNOWN,
  isCardanoNetwork,
  POSITIVE_CANONICAL_AMOUNT_REGEX,
  SCHEME_EXACT,
  SUBMISSION_POLICY_EITHER,
} from "../../constants";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";
import { resolveCardanoPolicies } from "../../policy";
import type { CardanoExtraMasumi } from "../../types";
import { decodeCardanoTransaction } from "../../utils";
import { buildSignedTerms, computeTermsDigest } from "../masumi/digests";
import { validateMasumiExtra } from "../masumi/schema";
import { InMemoryMasumiTermsStorage, type MasumiTermsStorage } from "../masumi/storage";

/** Cardano resource-server configuration. */
export interface ExactCardanoServerConfig {
  /**
   * Storage for issued Masumi quotes, keyed by `termsDigest`. Defaults to a
   * process-local store, which is suitable for tests and single-process
   * development servers; a production deployment must supply a durable,
   * atomically-updating implementation shared by every worker.
   *
   * Only the `masumi` asset transfer method uses it — `default` and `script`
   * payments never touch storage.
   */
  masumiStorage?: MasumiTermsStorage;
}

/**
 * Returns whether a requirements `extra` selects the Masumi transfer method.
 *
 * @param extra - Requirements `extra` block.
 * @returns True when the block selects `masumi`.
 */
function isMasumiExtra(extra: unknown): boolean {
  return (
    typeof extra === "object" &&
    extra !== null &&
    (extra as { assetTransferMethod?: unknown }).assetTransferMethod ===
      ASSET_TRANSFER_METHOD_MASUMI
  );
}

/**
 * Computes the seller-signed terms digest a Masumi requirement is bound to.
 *
 * @param requirements - Masumi payment requirements.
 * @returns Lowercase hexadecimal terms digest.
 */
function masumiTermsDigest(requirements: PaymentRequirements): string {
  return computeTermsDigest(
    buildSignedTerms(requirements.extra as unknown as CardanoExtraMasumi, requirements),
  );
}

/**
 * Cardano server-side implementation for the Exact scheme.
 *
 * Performs Money-to-AssetAmount parsing using a registerable parser chain and
 * leaves Cardano-specific extra fields untouched, since most extras are
 * server-supplied (assetTransferMethod, Masumi metadata, script descriptors).
 *
 * For `masumi`, each issued 402 is persisted under its `termsDigest` and the
 * paid retry must present that exact quote: the digest binds one buyer to one
 * seller-signed offer, and the first transaction to claim it is the only one
 * that may.
 */
export class ExactCardanoScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME_EXACT;
  readonly defaultAssetTransferMethod = ASSET_TRANSFER_METHOD_DEFAULT;
  /**
   * Every Cardano asset transfer method is a signed-but-unbroadcast (or
   * client-broadcast, evidence-checked) transaction: verify is read-only and
   * settle runs after the handler, i.e. the `authorization` flow. Who
   * broadcasts (submission policy) and how much L1 evidence is required
   * (confirmation policy) are orthogonal to flow ordering.
   */
  readonly paymentFlows = {
    [ASSET_TRANSFER_METHOD_DEFAULT]: { supported: ["authorization"], default: "authorization" },
    [ASSET_TRANSFER_METHOD_MASUMI]: { supported: ["authorization"], default: "authorization" },
    [ASSET_TRANSFER_METHOD_SCRIPT]: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  readonly schemeHooks: SchemeServerHooks;
  private readonly moneyParsers: MoneyParser[] = [];
  private readonly masumiStorage: MasumiTermsStorage;

  /**
   * Creates a server scheme with its Masumi quote-binding hook.
   *
   * @param config - Masumi quote storage options.
   */
  constructor(config: ExactCardanoServerConfig = {}) {
    this.masumiStorage = config.masumiStorage ?? new InMemoryMasumiTermsStorage();
    this.schemeHooks = {
      onAfterVerify: async context => this.bindMasumiTerms(context),
    };
  }

  /**
   * Persists every Masumi quote this response serves, keyed by `termsDigest`.
   *
   * The first 402 for a digest wins: a later response carrying the same terms
   * cannot rotate what the buyer was quoted, and the paid retry is compared
   * against the stored copy rather than against whatever the route currently
   * offers.
   *
   * @param context - Payment-required response being built.
   */
  async enrichPaymentRequiredResponse(context: SchemePaymentRequiredContext): Promise<void> {
    for (const requirement of context.requirements) {
      if (requirement.scheme !== this.scheme || !isCardanoNetwork(requirement.network)) continue;
      if (!isMasumiExtra(requirement.extra)) continue;

      const termsDigest = masumiTermsDigest(requirement);
      const issued = structuredClone(requirement) as PaymentRequirements;
      await this.masumiStorage.updateTerms(
        termsDigest,
        current => current ?? { termsDigest, requirements: issued },
      );
    }
  }

  /**
   * Registers a custom Money parser. Parsers are tried in registration order;
   * the first non-null result wins. Returns `null` to defer to the next parser.
   *
   * @param parser - The parser to register.
   * @returns This instance for chaining.
   */
  registerMoneyParser(parser: MoneyParser): ExactCardanoScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Converts a price into an AssetAmount. AssetAmount inputs are passed through
   * after validation. Money inputs use the parser chain, then USDM conversion.
   *
   * @param price - The price to parse.
   * @param network - The Cardano network identifier.
   * @returns The resolved AssetAmount.
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset unit must be specified for AssetAmount on network ${network}`);
      }
      return this.validateAssetAmount(
        { amount: price.amount, asset: price.asset, extra: price.extra ?? {} },
        "AssetAmount",
      );
    }

    const { amount, symbol } = parseMoney(price as Money);
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return this.validateAssetAmount(result, "Custom money parser result");
      }
    }
    return this.validateAssetAmount(
      this.defaultMoneyConversion(amount, network, symbol),
      "Default money conversion",
    );
  }

  /**
   * Returns the decimal precision for a known default asset (USDM). Other
   * units, including `lovelace`, are unknown here so `$…` settlement
   * overrides against them are rejected by core instead of mis-scaled.
   *
   * @param asset - The asset unit string.
   * @param network - The Cardano network identifier.
   * @returns Decimal precision, or undefined when the asset is not a default.
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
  }

  /**
   * Leaves requirement extras unchanged. `/supported` extras advertise
   * capabilities; they are not payment semantics and Masumi extras are closed.
   *
   * @param paymentRequirements - The base payment requirements.
   * @param supportedKind - The matching SupportedKind.
   * @param extensionKeys - The facilitator extension keys.
   * @returns The unchanged payment requirements.
   */
  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    void extensionKeys;
    if (!isCardanoNetwork(supportedKind.network)) {
      throw new Error(`Unsupported Cardano network: ${supportedKind.network}`);
    }
    this.assertFacilitatorSupportsRequirements(paymentRequirements, supportedKind);
    // The one capability restated in the 402: who pays the network fee. Copied
    // from the facilitator's advertisement, as on the other schemes. Every
    // other capability key stays out of `extra`, which the Masumi schema
    // validates as a closed object.
    const areFeesSponsored = supportedKind.extra?.areFeesSponsored;
    return {
      ...paymentRequirements,
      extra: {
        ...paymentRequirements.extra,
        ...(typeof areFeesSponsored === "boolean" && { areFeesSponsored }),
      },
    };
  }

  /**
   * Binds a verified Masumi payment to the quote it was issued against.
   *
   * `default` and `script` payments return immediately: they carry no
   * server-issued terms, so there is nothing to hand back to.
   *
   * @param context - Core after-verify hook context.
   * @returns An abort directive when the quote is unknown, altered, or already
   *   claimed by another transaction.
   */
  private async bindMasumiTerms(
    context: Parameters<NonNullable<SchemeServerHooks["onAfterVerify"]>>[0],
  ): Promise<void | { abort: true; reason: string; message: string }> {
    if (!context.result.isValid) return;
    const accepted = context.paymentPayload.accepted as PaymentRequirements | undefined;
    if (!accepted || !isMasumiExtra(accepted.extra)) return;

    let termsDigest: string;
    let txHash: string;
    try {
      termsDigest = masumiTermsDigest(accepted);
      const transaction = (context.paymentPayload.payload as { transaction?: unknown }).transaction;
      if (typeof transaction !== "string") {
        throw new Error("Cardano transaction is missing");
      }
      txHash = decodeCardanoTransaction(transaction).txHash;
    } catch (cause) {
      return {
        abort: true,
        reason: ERR_INVALID_PAYLOAD,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }

    // The claim decision happens inside the atomic callback; the returned record
    // is then the authority for what this payment is allowed to do.
    const { terms: stored } = await this.masumiStorage.updateTerms(termsDigest, current => {
      if (!current) return current;
      if (!deepEqual(accepted, current.requirements)) return current;
      if (current.claimedTxHash === undefined) {
        return { ...current, claimedTxHash: txHash };
      }
      return current;
    });

    if (!stored) {
      return {
        abort: true,
        reason: ERR_MASUMI_TERMS_UNKNOWN,
        message: "Masumi payment quotes terms this server did not issue",
      };
    }
    if (!deepEqual(accepted, stored.requirements)) {
      return {
        abort: true,
        reason: ERR_MASUMI_TERMS_MISMATCH,
        message: "Masumi payment altered the issued payment requirements",
      };
    }
    // An identical paid retry of the same transaction is the resume case the
    // spec's pending-confirmation flow depends on, so it stays permitted.
    if (stored.claimedTxHash !== txHash) {
      return {
        abort: true,
        reason: ERR_DUPLICATE_SETTLEMENT,
        message: "Masumi terms are already bound to a different Cardano transaction",
      };
    }
  }

  /**
   * Checks selected Cardano payment semantics against the facilitator's
   * advertised capabilities without copying capability metadata into the 402.
   *
   * The check is all-or-nothing on purpose. A facilitator that publishes no
   * `extra` at all has told us nothing, so there is nothing to check and the
   * requirements pass. One that publishes an `extra` has claimed to describe
   * itself, and every capability this scheme selects must then appear in it —
   * a half-filled advertisement is treated as a rejection rather than as
   * permission, because the alternative is serving a 402 nobody can settle.
   *
   * @param requirements - Requirements about to be served.
   * @param supportedKind - Matching facilitator capability advertisement.
   */
  private assertFacilitatorSupportsRequirements(
    requirements: PaymentRequirements,
    supportedKind: SupportedKind,
  ): void {
    const advertised = supportedKind.extra;
    if (advertised === undefined || advertised === null) return;
    if (typeof advertised !== "object" || Array.isArray(advertised)) {
      throw new Error("Cardano facilitator advertised a malformed capability block");
    }

    const capabilities = advertised as Record<string, unknown>;
    const method = requirements.extra?.assetTransferMethod ?? ASSET_TRANSFER_METHOD_DEFAULT;
    const methods = capabilities.assetTransferMethods;
    if (!Array.isArray(methods)) {
      throw new Error("Cardano facilitator did not advertise assetTransferMethods");
    }
    if (!methods.includes(method)) {
      throw new Error(`Cardano facilitator does not support assetTransferMethod ${String(method)}`);
    }

    const policies = resolveCardanoPolicies(requirements.extra);
    if (!policies) {
      throw new Error("Cardano requirements carry an invalid submission/confirmation policy");
    }
    const selectedModes =
      policies.submissionPolicy === SUBMISSION_POLICY_EITHER
        ? (["server", "client"] as const)
        : ([policies.submissionPolicy] as const);
    const advertisedModes = capabilities.submissionModes;
    if (!Array.isArray(advertisedModes)) {
      throw new Error("Cardano facilitator did not advertise submissionModes");
    }
    const confirmationRanges = capabilities.l1Confirmations;
    if (
      !confirmationRanges ||
      typeof confirmationRanges !== "object" ||
      Array.isArray(confirmationRanges)
    ) {
      throw new Error("Cardano facilitator did not advertise l1Confirmations");
    }
    for (const mode of selectedModes) {
      if (!advertisedModes.includes(mode)) {
        throw new Error(`Cardano facilitator does not support ${mode} submission`);
      }
      const range = (confirmationRanges as Record<string, unknown>)[mode];
      if (!range || typeof range !== "object" || Array.isArray(range)) {
        throw new Error(
          `Cardano facilitator did not advertise an L1 confirmation range for ${mode}`,
        );
      }
      const minimum = (range as Record<string, unknown>).minimum;
      const maximum = (range as Record<string, unknown>).maximum;
      if (
        typeof minimum !== "number" ||
        !Number.isInteger(minimum) ||
        typeof maximum !== "number" ||
        !Number.isInteger(maximum) ||
        policies.confirmationPolicy.l1Confirmations < minimum ||
        policies.confirmationPolicy.l1Confirmations > maximum
      ) {
        throw new Error(
          `Cardano facilitator ${mode} confirmation range does not include ${policies.confirmationPolicy.l1Confirmations}`,
        );
      }
    }

    if (method === ASSET_TRANSFER_METHOD_MASUMI) {
      // `extra` is still the raw wire object here, so `settlementPolicy` comes
      // from the schema check rather than from an unchecked cast. The schema
      // requires the field, which is why there is no default to apply.
      const schema = validateMasumiExtra(requirements.extra, requirements.network);
      if (!schema.ok) {
        throw new Error(`Cardano Masumi requirements are invalid: ${schema.detail}`);
      }
      const settlementPolicy = schema.extra.terms.settlementPolicy;
      const advertisedLayers = capabilities.settlementLayers;
      if (!Array.isArray(advertisedLayers)) {
        throw new Error("Cardano facilitator did not advertise settlementLayers");
      }
      // `auto` lets the buyer choose, and the only layer this scheme can
      // actually authenticate is L1 — a Hydra payload is refused outright in
      // `verifyMasumiLock`. Accepting `auto` against a Hydra-only facilitator
      // would serve a 402 whose every payment is rejected at verification.
      // An explicit `hydra` policy still defers to the advertisement, so a
      // subclass that does implement Hydra keeps working.
      const supported =
        settlementPolicy === "auto"
          ? advertisedLayers.includes("l1")
          : advertisedLayers.includes(settlementPolicy);
      if (!supported) {
        throw new Error(
          `Cardano facilitator does not support Masumi ${String(settlementPolicy)} settlement`,
        );
      }
    }
  }

  /**
   * Ensures requirements use the same canonical wire forms enforced by the
   * Cardano client and facilitator.
   *
   * @param value - Parsed amount and asset.
   * @param source - Label included in validation errors.
   * @returns The unchanged, validated value.
   */
  private validateAssetAmount(value: AssetAmount, source: string): AssetAmount {
    if (!POSITIVE_CANONICAL_AMOUNT_REGEX.test(value.amount)) {
      throw new Error(`${source} amount must be a positive canonical integer: ${value.amount}`);
    }
    if (!CANONICAL_CARDANO_ASSET_REGEX.test(value.asset)) {
      throw new Error(`${source} asset must use canonical lowercase Cardano form: ${value.asset}`);
    }
    return value;
  }

  /**
   * Falls back to converting a Money decimal to atomic units of the network's
   * default asset (or the ticker-selected one, e.g. `"1 USDM"`).
   *
   * @param amount - The decimal amount string.
   * @param network - The Cardano network identifier.
   * @param symbol - Optional ticker parsed from the Money string.
   * @returns The resulting AssetAmount.
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    const tokenAmount = convertToTokenAmount(amount, assetInfo.decimals);
    return { amount: tokenAmount, asset: assetInfo.asset, extra: {} };
  }
}
