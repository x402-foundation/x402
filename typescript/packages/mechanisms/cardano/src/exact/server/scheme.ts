import type {
  AssetAmount,
  Money,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentPayload,
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
  normalizeCardanoNetwork,
  POSITIVE_CANONICAL_AMOUNT_REGEX,
  SCHEME_EXACT,
} from "../../constants";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";
import { resolveCardanoPolicies } from "../../policy";
import type { CardanoExtraMasumi } from "../../types";
import { decodeCardanoTransaction } from "../../utils";
import { buildSignedTerms, computeTermsDigest } from "../masumi/digests";
import { validateMasumiExtra } from "../masumi/schema";
import { InMemoryMasumiTermsStorage, type MasumiTermsStorage } from "../masumi/storage";
import {
  isMasumiExtra,
  isMasumiTemplate,
  MasumiQuoteIssuer,
  type MasumiIssuerConfig,
} from "./masumiIssuer";

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
  /**
   * Lets the scheme issue Masumi quotes itself. A route then declares only
   * `extra: { assetTransferMethod: "masumi" }` with the escrow address as
   * `payTo`; every 402 gets a fresh seller-signed quote and a paid retry is
   * answered with the quote it was issued. Without this block, Masumi routes
   * must serve fully issued requirements (see `issueMasumiRequirements`).
   */
  masumi?: MasumiIssuerConfig;
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
 * that may. With a `masumi` issuer configured, the scheme also produces those
 * quotes: a route template gets a fresh seller-signed quote per 402, and the
 * paid retry is matched against the stored quote its payload names.
 */
export class ExactCardanoScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME_EXACT;
  readonly defaultAssetTransferMethod = ASSET_TRANSFER_METHOD_DEFAULT;
  /**
   * Every Cardano asset transfer method is a signed-but-unbroadcast transaction
   * the facilitator submits: verify is read-only and settle runs after the
   * handler, i.e. the `authorization` flow. How much L1 evidence settlement
   * waits for (confirmation policy) is orthogonal to flow ordering.
   */
  readonly paymentFlows = {
    [ASSET_TRANSFER_METHOD_DEFAULT]: { supported: ["authorization"], default: "authorization" },
    [ASSET_TRANSFER_METHOD_MASUMI]: { supported: ["authorization"], default: "authorization" },
    [ASSET_TRANSFER_METHOD_SCRIPT]: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  readonly schemeHooks: SchemeServerHooks;
  private readonly moneyParsers: MoneyParser[] = [];
  private readonly masumiStorage: MasumiTermsStorage;
  private readonly masumiIssuer?: MasumiQuoteIssuer;

  /**
   * Creates a server scheme with its Masumi quote-binding hook.
   *
   * @param config - Masumi quote storage and issuance options.
   */
  constructor(config: ExactCardanoServerConfig = {}) {
    this.masumiStorage = config.masumiStorage ?? new InMemoryMasumiTermsStorage();
    this.masumiIssuer = config.masumi ? new MasumiQuoteIssuer(config.masumi) : undefined;
    this.schemeHooks = {
      onAfterVerify: async context => this.bindMasumiTerms(context),
    };
  }

  /**
   * Issues and persists the Masumi quotes this response serves.
   *
   * A Masumi *template* (the method selected, no seller-signed `terms`) is
   * replaced by a quote: on a paid retry, the stored quote the payload's
   * `accepted` names, when it is still compatible with the template; otherwise a
   * freshly issued one. Fully issued Masumi requirements pass through. Core
   * invokes this hook once per Cardano accept and lets only accepts on the
   * invoking accept's network gain `extra` keys, so one template is replaced per
   * call — in accept order, which is the order core invokes it in.
   *
   * Every served quote is persisted under its `termsDigest`. The first 402 for a
   * digest wins: a later response carrying the same terms cannot rotate what
   * the buyer was quoted, and the paid retry is compared against the stored
   * copy rather than against whatever the route currently offers.
   *
   * @param context - Payment-required response being built.
   * @returns The accepts with templates replaced, or nothing when none were.
   */
  async enrichPaymentRequiredResponse(
    context: SchemePaymentRequiredContext,
  ): Promise<PaymentRequirements[] | void> {
    let replaced: PaymentRequirements[] | undefined;
    let paidPayload: PaymentPayload | undefined | null = null;

    for (const [index, requirement] of context.requirements.entries()) {
      if (requirement.scheme !== this.scheme || !isCardanoNetwork(requirement.network)) continue;
      if (!isMasumiExtra(requirement.extra)) continue;

      let served = requirement;
      if (isMasumiTemplate(requirement.extra) && replaced === undefined) {
        if (!this.masumiIssuer) {
          throw new Error(
            "Masumi requirements must carry seller-signed terms unless ExactCardanoScheme is configured with a `masumi` issuer",
          );
        }
        if (paidPayload === null) {
          paidPayload = this.masumiIssuer.paidPayload(
            context.paymentPayload as PaymentPayload | undefined,
            context.transportContext,
          );
        }
        served =
          (await this.storedQuoteFor(paidPayload, requirement)) ??
          (await this.masumiIssuer.issue(
            requirement,
            context.resourceInfo,
            context.transportContext,
          ));
        replaced = [...context.requirements];
        replaced[index] = served;
      } else if (isMasumiTemplate(requirement.extra)) {
        // Left for the next invocation of this hook.
        continue;
      }

      const termsDigest = masumiTermsDigest(served);
      const stored = structuredClone(served) as PaymentRequirements;
      await this.masumiStorage.updateTerms(
        termsDigest,
        current => current ?? { termsDigest, requirements: stored },
      );
    }
    return replaced;
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
    if (isMasumiTemplate(paymentRequirements.extra)) {
      if (!this.masumiIssuer) {
        throw new Error(
          "Masumi requirements must carry seller-signed terms unless ExactCardanoScheme is configured with a `masumi` issuer",
        );
      }
      this.masumiIssuer.assertTemplate(paymentRequirements);
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
   * Finds the quote a paid retry was issued, when this server still holds it
   * and it still fits the template the route declares.
   *
   * @param payload - The paid payload, if the 402 is a response to one.
   * @param template - The template requirement being served.
   * @returns The stored quote, or undefined to issue a fresh one.
   */
  private async storedQuoteFor(
    payload: PaymentPayload | undefined,
    template: PaymentRequirements,
  ): Promise<PaymentRequirements | undefined> {
    const accepted = payload?.accepted as PaymentRequirements | undefined;
    if (
      !accepted ||
      accepted.scheme !== template.scheme ||
      typeof accepted.network !== "string" ||
      normalizeCardanoNetwork(accepted.network) !== normalizeCardanoNetwork(template.network) ||
      !isMasumiExtra(accepted.extra) ||
      !validateMasumiExtra(accepted.extra, accepted.network).ok
    ) {
      return undefined;
    }
    const stored = (await this.masumiStorage.get(masumiTermsDigest(accepted)))?.requirements;
    if (!stored) return undefined;
    // The quote must still be what the route offers: core keeps the template's
    // payment terms immutable through enrichment, and every template extra key
    // must survive unchanged.
    if (
      stored.scheme !== template.scheme ||
      stored.network !== template.network ||
      stored.payTo !== template.payTo ||
      stored.amount !== template.amount ||
      stored.asset !== template.asset ||
      stored.maxTimeoutSeconds !== template.maxTimeoutSeconds
    ) {
      return undefined;
    }
    for (const [key, value] of Object.entries(template.extra ?? {})) {
      if (!deepEqual(stored.extra?.[key], value)) return undefined;
    }
    return structuredClone(stored) as PaymentRequirements;
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
      throw new Error("Cardano requirements carry an invalid confirmation policy");
    }
    const range = capabilities.l1Confirmations;
    if (!range || typeof range !== "object" || Array.isArray(range)) {
      throw new Error("Cardano facilitator did not advertise an l1Confirmations range");
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
        `Cardano facilitator confirmation range does not include ${policies.confirmationPolicy.l1Confirmations}`,
      );
    }

    if (method === ASSET_TRANSFER_METHOD_MASUMI && !isMasumiTemplate(requirements.extra)) {
      const schema = validateMasumiExtra(requirements.extra, requirements.network);
      if (!schema.ok) {
        throw new Error(`Cardano Masumi requirements are invalid: ${schema.detail}`);
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
