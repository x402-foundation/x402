package org.x402.mechanisms.cardano.exact.server;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CopyOnWriteArrayList;
import org.x402.core.MoneyParser;
import org.x402.core.PaymentFlow;
import org.x402.core.SchemeNetworkClient.DefaultAsset;
import org.x402.core.SchemeNetworkServer;
import org.x402.core.hooks.HookResults.AfterVerifyResult;
import org.x402.core.server.ServerHooks.SchemeServerHooks;
import org.x402.core.server.ServerHooks.VerifyResultContext;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.Money;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.Price;
import org.x402.core.types.SupportedKind;
import org.x402.core.utils.Amounts;
import org.x402.mechanisms.cardano.utils.CardanoConstants;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.utils.CardanoPolicies;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.DefaultAssets;
import org.x402.mechanisms.cardano.utils.Jcs;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDigests;
import org.x402.mechanisms.cardano.exact.masumi.MasumiSchema;
import org.x402.mechanisms.cardano.exact.masumi.MasumiTermsRecord;
import org.x402.mechanisms.cardano.exact.masumi.MasumiTermsStorage;

/**
 * Cardano resource-server scheme for {@code exact}: money
 * parsing with USDM as the default asset, the facilitator capability check, Masumi quote issuance
 * and storage, and the Masumi terms binding as an after-verify scheme hook (spec section on terms
 * binding). The first transaction to claim a served quote owns it; any other transaction is a
 * duplicate.
 */
public class ExactCardanoServerScheme implements SchemeNetworkServer {

  private static final String ISSUER_REQUIRED =
      "Masumi requirements must carry seller-signed terms unless ExactCardanoScheme is configured with a `masumi` issuer";

  private final List<MoneyParser> moneyParsers = new CopyOnWriteArrayList<>();
  private final MasumiTermsStorage masumiStorage;
  private final MasumiQuoteIssuer masumiIssuer;
  private final SchemeServerHooks schemeHooks;

  /** A server scheme with in-memory quote storage and no issuer. */
  public ExactCardanoServerScheme() {
    this(ExactCardanoServerConfig.builder().build());
  }

  /**
   * Creates the server scheme.
   *
   * @param config storage and issuance options
   */
  public ExactCardanoServerScheme(ExactCardanoServerConfig config) {
    Objects.requireNonNull(config, "config");
    this.masumiStorage = config.masumiStorage();
    this.masumiIssuer = config.masumi() == null ? null : new MasumiQuoteIssuer(config.masumi());
    this.schemeHooks = new SchemeServerHooks(null, this::bindMasumiTerms, null, null, null, null, null);
  }

  @Override
  public String scheme() {
    return CardanoConstants.SCHEME_EXACT;
  }

  @Override
  public String defaultAssetTransferMethod() {
    return CardanoConstants.METHOD_DEFAULT;
  }

  @Override
  public Map<String, PaymentFlow.Config> paymentFlows() {
    Map<String, PaymentFlow.Config> flows = new LinkedHashMap<>();
    flows.put(CardanoConstants.METHOD_DEFAULT, PaymentFlow.Config.authorizationOnly());
    flows.put(CardanoConstants.METHOD_MASUMI, PaymentFlow.Config.authorizationOnly());
    flows.put(CardanoConstants.METHOD_SCRIPT, PaymentFlow.Config.authorizationOnly());
    return flows;
  }

  @Override
  public SchemeServerHooks schemeHooks() {
    return schemeHooks;
  }

  /**
   * Registers a money parser; parsers run in registration order and the first non-null result
   * wins.
   *
   * @param parser the parser
   * @return this scheme
   */
  public ExactCardanoServerScheme registerMoneyParser(MoneyParser parser) {
    moneyParsers.add(Objects.requireNonNull(parser, "parser"));
    return this;
  }

  @Override
  public AssetAmount parsePrice(Price price, String network) {
    if (price instanceof AssetAmount amount) {
      if (amount.asset() == null || amount.asset().isEmpty()) {
        throw new IllegalArgumentException("Asset unit must be specified for AssetAmount on network " + network);
      }
      return validate(
          new AssetAmount(amount.asset(), amount.amount(), amount.extra() == null ? Map.of() : amount.extra()),
          "AssetAmount");
    }
    Amounts.ParsedMoney money = Amounts.parseMoney(((Money) price).value());
    for (MoneyParser parser : moneyParsers) {
      AssetAmount result = parser.parse(money.amount(), network);
      if (result != null) {
        return validate(result, "Custom money parser result");
      }
    }
    DefaultAsset asset = DefaultAssets.get(network, money.symbol());
    return validate(
        new AssetAmount(asset.asset(), Amounts.convertToTokenAmount(money.amount(), asset.decimals()), Map.of()),
        "Default money conversion");
  }

  private static AssetAmount validate(AssetAmount value, String source) {
    if (value.amount() == null || !CardanoConstants.POSITIVE_CANONICAL_AMOUNT.matcher(value.amount()).matches()) {
      throw new IllegalArgumentException(source + " amount must be a positive canonical integer: " + value.amount());
    }
    if (value.asset() == null || !CardanoConstants.CANONICAL_ASSET.matcher(value.asset()).matches()) {
      throw new IllegalArgumentException(
          source + " asset must use canonical lowercase Cardano form: " + value.asset());
    }
    return value;
  }

  @Override
  public Integer getAssetDecimals(String asset, String network) {
    DefaultAsset found = DefaultAssets.find(asset, network);
    return found == null ? null : found.decimals();
  }

  @Override
  public PaymentRequirements enhancePaymentRequirements(
      PaymentRequirements requirements, SupportedKind supportedKind, List<String> facilitatorExtensions) {
    if (!CardanoNetworks.isCardanoNetwork(supportedKind.network())) {
      throw new IllegalArgumentException("Unsupported Cardano network: " + supportedKind.network());
    }
    if (MasumiQuoteIssuer.isMasumiTemplate(requirements.extra())) {
      if (masumiIssuer == null) {
        throw new IllegalArgumentException(ISSUER_REQUIRED);
      }
      masumiIssuer.assertTemplate(requirements);
    }
    assertFacilitatorSupports(requirements.extra(), requirements.network(), supportedKind, true);
    Object areFeesSponsored = supportedKind.extra() == null ? null : supportedKind.extra().get("areFeesSponsored");
    Map<String, Object> extra = new LinkedHashMap<>(requirements.extra());
    if (areFeesSponsored instanceof Boolean sponsored) {
      extra.put("areFeesSponsored", sponsored);
    }
    return requirements.withExtra(extra);
  }

  /**
   * The facilitator checks {@link #enhancePaymentRequirements} runs on every request, at startup:
   * the facilitator must advertise the option's transfer method and a confirmation range that
   * holds its policy. A {@code null} option is not checked; the option's own configuration (an
   * invalid policy, a Masumi schema) is left to {@link #validateOption}, which is never retried.
   */
  @Override
  public String validateFacilitatorSupport(String network, SupportedKind supportedKind,
      List<String> facilitatorExtensions, Map<String, Object> optionExtra) {
    if (optionExtra == null) {
      return null;
    }
    try {
      assertFacilitatorSupports(optionExtra, network, supportedKind, false);
      return null;
    } catch (IllegalArgumentException e) {
      return e.getMessage();
    }
  }

  /**
   * The option's own configuration: a valid confirmation policy and, for a fixed Masumi quote, a
   * schema-valid one. These never depend on the facilitator.
   */
  @Override
  public String validateOption(String network, Map<String, Object> optionExtra) {
    if (optionExtra == null) {
      return null;
    }
    if (CardanoPolicies.l1Confirmations(optionExtra) != null
        && MasumiQuoteIssuer.isMasumiTemplate(optionExtra) && masumiIssuer == null) {
      // The template's own fields need the full requirements and are checked per request. An
      // invalid policy is reported first, as below.
      return ISSUER_REQUIRED;
    }
    return optionProblem(optionExtra, network);
  }

  /**
   * The option's own configuration problem, or {@code null}: an invalid confirmation policy, or a
   * fixed Masumi quote that violates the schema (a template is checked by its issuer).
   */
  private static String optionProblem(Map<String, Object> extra, String network) {
    if (CardanoPolicies.l1Confirmations(extra) == null) {
      return "Cardano requirements carry an invalid confirmation policy";
    }
    if (CardanoConstants.METHOD_MASUMI.equals(extra.get("assetTransferMethod"))
        && !MasumiQuoteIssuer.isMasumiTemplate(extra)) {
      MasumiSchema.Result schema = MasumiSchema.validate(extra, network);
      if (!schema.ok()) {
        return "Cardano Masumi requirements are invalid: " + schema.detail();
      }
    }
    return null;
  }

  /**
   * The facilitator checks; with {@code optionChecks} also the option's own configuration (per
   * request), without it those are skipped (at startup they are {@link #validateOption}'s). The
   * option checks run even when the facilitator's kind advertises no capabilities: a dynamic
   * price is never seen by {@link #validateOption}.
   */
  private static void assertFacilitatorSupports(Map<String, Object> extra, String network, SupportedKind kind,
      boolean optionChecks) {
    Map<String, Object> capabilities = kind.extra();
    if (capabilities == null) {
      String problem = optionChecks ? optionProblem(extra, network) : null;
      if (problem != null) {
        throw new IllegalArgumentException(problem);
      }
      return;
    }
    Object method = extra.get("assetTransferMethod");
    if (method == null) {
      method = CardanoConstants.METHOD_DEFAULT;
    }
    if (!(capabilities.get("assetTransferMethods") instanceof List<?> methods)) {
      throw new IllegalArgumentException("Cardano facilitator did not advertise assetTransferMethods");
    }
    if (!methods.contains(method)) {
      throw new IllegalArgumentException("Cardano facilitator does not support assetTransferMethod " + method);
    }
    Integer l1 = CardanoPolicies.l1Confirmations(extra);
    if (l1 == null) {
      if (!optionChecks) {
        return;
      }
      throw new IllegalArgumentException("Cardano requirements carry an invalid confirmation policy");
    }
    if (!(capabilities.get("l1Confirmations") instanceof Map<?, ?> range)) {
      throw new IllegalArgumentException("Cardano facilitator did not advertise an l1Confirmations range");
    }
    Integer minimum = integer(range.get("minimum"));
    Integer maximum = integer(range.get("maximum"));
    if (minimum == null || maximum == null || l1 < minimum || l1 > maximum) {
      throw new IllegalArgumentException("Cardano facilitator confirmation range does not include " + l1);
    }
    String problem = optionChecks ? optionProblem(extra, network) : null;
    if (problem != null) {
      throw new IllegalArgumentException(problem);
    }
  }

  private static Integer integer(Object value) {
    if (value instanceof Integer || value instanceof Long || value instanceof Short) {
      long v = ((Number) value).longValue();
      return v >= Integer.MIN_VALUE && v <= Integer.MAX_VALUE ? (int) v : null;
    }
    if (value instanceof Double d && d == Math.rint(d) && Math.abs(d) <= Integer.MAX_VALUE) {
      return d.intValue();
    }
    return null;
  }

  @Override
  public List<PaymentRequirements> enrichPaymentRequiredResponse(PaymentRequiredContext context) {
    List<PaymentRequirements> replaced = null;
    PaymentPayload paidPayload = null;
    boolean paidResolved = false;
    List<PaymentRequirements> requirements = context.requirements();
    // Each invocation is for one option, whose network alone may gain extra fields; without
    // the index, the first template is issued and the rest are left for later invocations.
    int only = context.acceptIndex();
    for (int index = 0; index < requirements.size(); index++) {
      if (only >= 0 && index != only) {
        continue;
      }
      PaymentRequirements requirement = requirements.get(index);
      if (!scheme().equals(requirement.scheme()) || !CardanoNetworks.isCardanoNetwork(requirement.network())) {
        continue;
      }
      if (!MasumiQuoteIssuer.isMasumiExtra(requirement.extra())) {
        continue;
      }
      PaymentRequirements served = requirement;
      if (MasumiQuoteIssuer.isMasumiTemplate(requirement.extra())) {
        if (replaced != null) {
          continue; // left for the next invocation of this hook
        }
        if (masumiIssuer == null) {
          throw new IllegalArgumentException(ISSUER_REQUIRED);
        }
        if (!paidResolved) {
          paidPayload = masumiIssuer.paidPayload(context.paymentPayload(), context.transportContext());
          paidResolved = true;
        }
        PaymentRequirements stored = storedQuoteFor(paidPayload, requirement);
        served =
            stored != null
                ? stored
                : masumiIssuer.issue(requirement, context.resourceInfo(), context.transportContext());
        replaced = new ArrayList<>(requirements);
        replaced.set(index, served);
      }
      String termsDigest = MasumiDigests.termsDigest(served);
      PaymentRequirements toStore = served;
      masumiStorage.updateTerms(
          termsDigest, current -> current != null ? current : new MasumiTermsRecord(termsDigest, toStore, null));
    }
    return replaced;
  }

  /** The quote a paid retry was issued, when still stored and still fitting the template. */
  private PaymentRequirements storedQuoteFor(PaymentPayload payload, PaymentRequirements template) {
    PaymentRequirements accepted = payload == null ? null : payload.accepted();
    if (accepted == null
        || !Objects.equals(accepted.scheme(), template.scheme())
        || accepted.network() == null
        || !Objects.equals(CardanoNetworks.normalize(accepted.network()), CardanoNetworks.normalize(template.network()))
        || !MasumiQuoteIssuer.isMasumiExtra(accepted.extra())
        || !MasumiSchema.validate(accepted.extra(), accepted.network()).ok()) {
      return null;
    }
    MasumiTermsRecord record = masumiStorage.get(MasumiDigests.termsDigest(accepted));
    PaymentRequirements stored = record == null ? null : record.requirements();
    if (stored == null
        || !Objects.equals(stored.scheme(), template.scheme())
        || !Objects.equals(stored.network(), template.network())
        || !Objects.equals(stored.payTo(), template.payTo())
        || !Objects.equals(stored.amount(), template.amount())
        || !Objects.equals(stored.asset(), template.asset())
        || stored.maxTimeoutSeconds() != template.maxTimeoutSeconds()) {
      return null;
    }
    for (Map.Entry<String, Object> e : template.extra().entrySet()) {
      if (!Jcs.deepEqual(stored.extra().get(e.getKey()), e.getValue())) {
        return null;
      }
    }
    return stored;
  }

  /**
   * Binds a verified Masumi payment to the quote it was issued against. {@code default} and {@code
   * script} payments pass through.
   *
   * @param context the after-verify context
   * @return proceed, or an abort for unknown, altered or already claimed terms
   */
  protected AfterVerifyResult bindMasumiTerms(VerifyResultContext context) {
    if (context.result() == null || !context.result().isValid()) {
      return AfterVerifyResult.proceed();
    }
    PaymentRequirements accepted = context.paymentPayload() == null ? null : context.paymentPayload().accepted();
    if (accepted == null || !MasumiQuoteIssuer.isMasumiExtra(accepted.extra())) {
      return AfterVerifyResult.proceed();
    }
    String termsDigest;
    String txHash;
    try {
      termsDigest = MasumiDigests.termsDigest(accepted);
      Object transaction = context.paymentPayload().payload().get("transaction");
      if (!(transaction instanceof String tx)) {
        throw new IllegalArgumentException("Cardano transaction is missing");
      }
      txHash = CardanoTransactionDecoder.decode(tx).txHash();
    } catch (RuntimeException e) {
      return AfterVerifyResult.abort(
          CardanoErrors.INVALID_PAYLOAD, e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }

    // The claim decision happens inside the atomic callback; its result is the authority.
    // A storage failure aborts. Core swallows after-verify
    // hook exceptions, so a throw would let the handler run on unbound terms.
    MasumiTermsRecord stored;
    try {
      stored =
          masumiStorage
              .updateTerms(
                  termsDigest,
                  current -> {
                    if (current == null || !Jcs.deepEqual(accepted, current.requirements())) {
                      return current;
                    }
                    return current.claimedTxHash() == null ? current.withClaimedTxHash(txHash) : current;
                  })
              .terms();
    } catch (RuntimeException e) {
      return AfterVerifyResult.abort(
          CardanoErrors.MASUMI_TERMS_STORAGE_UNAVAILABLE,
          "Masumi terms storage failed: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
    }
    if (stored == null) {
      return AfterVerifyResult.abort(
          CardanoErrors.MASUMI_TERMS_UNKNOWN, "Masumi payment quotes terms this server did not issue");
    }
    if (!Jcs.deepEqual(accepted, stored.requirements())) {
      return AfterVerifyResult.abort(
          CardanoErrors.MASUMI_TERMS_MISMATCH, "Masumi payment altered the issued payment requirements");
    }
    if (!txHash.equals(stored.claimedTxHash())) {
      return AfterVerifyResult.abort(
          CardanoErrors.DUPLICATE_SETTLEMENT, "Masumi terms are already bound to a different Cardano transaction");
    }
    return AfterVerifyResult.proceed();
  }
}
