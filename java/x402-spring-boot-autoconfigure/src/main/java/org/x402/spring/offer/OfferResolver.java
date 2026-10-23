package org.x402.spring.offer;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import org.x402.core.SchemeNetworkServer;
import org.x402.core.server.PaymentFlows;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.Price;
import org.x402.http.DynamicPrice;
import org.x402.http.HttpRequestContext;
import org.x402.http.PaymentOption;
import org.x402.http.RouteConfig;
import org.x402.spring.X402ConfigurationException;
import org.x402.spring.X402DynamicPayTo;
import org.x402.spring.X402DynamicPrice;
import org.x402.spring.X402RouteCustomizer;
import org.x402.spring.properties.PriceSpec;
import org.x402.spring.properties.RawProperties;
import org.x402.spring.properties.X402Properties;
import org.x402.spring.properties.X402Properties.Accept;
import org.x402.spring.properties.X402Properties.Account;
import org.x402.spring.properties.X402Properties.Facilitator;
import org.x402.spring.properties.X402Properties.Offer;

/**
 * Turns offers + accounts + defaults into core routes. Every
 * problem is an {@link X402ConfigurationException} naming the offer and option index.
 */
public final class OfferResolver {

  private static final Pattern ACCOUNT_NAME = Pattern.compile("[a-z0-9-]+");
  private static final List<String> NETWORK_FIELDS = List.of("network", "pay-to", "pay-to-ref",
      "extra", "facilitator", "scheme", "max-timeout-seconds");
  private static final List<String> ACCEPTS_FIELDS = List.of("price", "price-ref", "accounts");

  /** Protocol {@code extra} keys whose case matters (env-var lowercasing check). */
  private static final List<String> PROTOCOL_KEYS = List.of(PaymentFlows.ASSET_TRANSFER_METHOD,
      PaymentFlows.PAYMENT_FLOW, "confirmationPolicy", "areFeesSponsored", "feePayer",
      "agentIdentifier", "termsDigest", "sellerVkey", "escrowAddress");

  private final X402Properties properties;
  private final Predicate<String> present;
  private final List<String> facilitators;
  private final List<X402OptionContributor> contributors;
  private final List<X402RouteCustomizer> routeCustomizers;
  private final Function<String, ? extends X402DynamicPrice> priceRefs;
  private final Function<String, ? extends X402DynamicPayTo> payToRefs;
  private final X402ResourceServer server;

  private OfferResolver(Builder b) {
    this.properties = b.properties;
    this.present = b.present;
    this.facilitators = b.facilitators.stream().map(Facilitator::normalize).toList();
    this.contributors = List.copyOf(b.contributors);
    this.routeCustomizers = List.copyOf(b.routeCustomizers);
    this.priceRefs = b.priceRefs;
    this.payToRefs = b.payToRefs;
    this.server = b.server;
  }

  /**
   * Starts a builder.
   *
   * @param properties the bound properties
   * @return the builder
   */
  public static Builder builder(X402Properties properties) {
    return new Builder(properties);
  }

  /** Builds an {@link OfferResolver}. */
  public static final class Builder {
    private final X402Properties properties;
    private Predicate<String> present = name -> false;
    private List<String> facilitators = List.of();
    private List<X402OptionContributor> contributors = List.of();
    private List<X402RouteCustomizer> routeCustomizers = List.of();
    private Function<String, ? extends X402DynamicPrice> priceRefs = name -> null;
    private Function<String, ? extends X402DynamicPayTo> payToRefs = name -> null;
    private X402ResourceServer server;

    private Builder(X402Properties properties) {
      this.properties = Objects.requireNonNull(properties, "properties");
    }

    /**
     * Sets the raw-presence check for fields the binder ignores.
     *
     * @param value whether a property (or a descendant) is set
     * @return this builder
     */
    public Builder presence(Predicate<String> value) {
      this.present = Objects.requireNonNull(value, "presence");
      return this;
    }

    /**
     * Sets the known effective facilitator identifiers (for pin checks).
     *
     * @param identifiers the identifiers
     * @return this builder
     */
    public Builder facilitators(List<String> identifiers) {
      this.facilitators = List.copyOf(identifiers);
      return this;
    }

    /**
     * Sets the option contributors, in order.
     *
     * @param value the contributors
     * @return this builder
     */
    public Builder contributors(List<? extends X402OptionContributor> value) {
      this.contributors = List.copyOf(value);
      return this;
    }

    /**
     * Sets the route customizers, in order.
     *
     * @param value the customizers
     * @return this builder
     */
    public Builder routeCustomizers(List<? extends X402RouteCustomizer> value) {
      this.routeCustomizers = List.copyOf(value);
      return this;
    }

    /**
     * Sets the {@code price-ref} bean lookup.
     *
     * @param value bean name → bean, or {@code null} when missing
     * @return this builder
     */
    public Builder priceRefs(Function<String, ? extends X402DynamicPrice> value) {
      this.priceRefs = Objects.requireNonNull(value, "priceRefs");
      return this;
    }

    /**
     * Sets the {@code pay-to-ref} bean lookup.
     *
     * @param value bean name → bean, or {@code null} when missing
     * @return this builder
     */
    public Builder payToRefs(Function<String, ? extends X402DynamicPayTo> value) {
      this.payToRefs = Objects.requireNonNull(value, "payToRefs");
      return this;
    }

    /**
     * Sets the server whose registered schemes check static prices at startup, so an
     * unsupported price such as {@code "1.5 ADA"} fails startup instead of the first request.
     *
     * @param value the server, may be {@code null}
     * @return this builder
     */
    public Builder server(X402ResourceServer value) {
      this.server = value;
      return this;
    }

    /**
     * Builds the resolver.
     *
     * @return the resolver
     */
    public OfferResolver build() {
      return new OfferResolver(this);
    }
  }

  /**
   * Resolves every offer.
   *
   * @return the offers
   * @throws X402ConfigurationException on the first problem
   */
  public X402Offers resolve() {
    checkAccounts();
    if (present.test("x402.defaults.extra")) {
      throw new X402ConfigurationException("x402.defaults.extra is not supported: extra keys are "
          + "protocol keys per network or transfer method; set them on an account "
          + "(x402.accounts.<name>.extra) or on an accepts entry");
    }
    Set<String> usedAccounts = new LinkedHashSet<>();
    Map<String, ResolvedOffer> resolved = new LinkedHashMap<>();
    properties.routes().forEach((name, offer) -> {
      checkOfferLevel(name);
      if (offer.accepts().isEmpty()) {
        throw new X402ConfigurationException("offer \"" + name + "\" has no accepts entries; "
            + "list its payment options under x402.routes." + name + ".accepts");
      }
      List<PaymentOption> options = new ArrayList<>();
      for (int i = 0; i < offer.accepts().size(); i++) {
        Accept accept = offer.accepts().get(i);
        if (accept == null) {
          throw new X402ConfigurationException(where(name, i) + ": empty accepts entry");
        }
        if (accept.account() != null) {
          usedAccounts.add(accept.account());
        }
        options.add(resolveOption(name, i, accept));
      }
      RouteConfig route = route(offer, options);
      for (X402RouteCustomizer customizer : routeCustomizers) {
        route = Objects.requireNonNull(customizer.customize(name, route), "customized route");
      }
      resolved.put(name, new ResolvedOffer(name, offer.path(), route));
    });
    List<String> warnings = new ArrayList<>();
    properties.accounts().keySet().stream().filter(a -> !usedAccounts.contains(a))
        .forEach(a -> warnings.add("x402: account \"" + a + "\" is not used by any offer"));
    return new X402Offers(resolved, warnings);
  }

  private void checkAccounts() {
    properties.accounts().forEach((name, account) -> {
      if (!ACCOUNT_NAME.matcher(name).matches()) {
        throw new X402ConfigurationException("x402 account name \"" + name
            + "\" must match [a-z0-9-]+");
      }
      if (account == null || account.network() == null || account.network().isBlank()) {
        throw new X402ConfigurationException("account \"" + name + "\" needs a network "
            + "(x402.accounts." + name + ".network, a CAIP-2 id such as cardano:preprod)");
      }
      if (account.payTo() != null && account.payToRef() != null) {
        throw new X402ConfigurationException("account \"" + name
            + "\": set either pay-to or pay-to-ref, not both");
      }
    });
  }

  private void checkOfferLevel(String name) {
    String prefix = "x402.routes." + name + ".";
    for (String field : NETWORK_FIELDS) {
      if (present.test(prefix + field)) {
        throw new X402ConfigurationException("offer \"" + name + "\": \"" + field
            + "\" is not allowed on an offer (it would apply to every network); set it on an "
            + "account (x402.accounts.<name>." + field + ") or on an accepts entry");
      }
    }
    for (String field : ACCEPTS_FIELDS) {
      if (present.test(prefix + field)) {
        throw new X402ConfigurationException("offer \"" + name + "\": \"" + field
            + "\" is not allowed on an offer; write each payment option as an accepts entry ("
            + prefix + "accepts[0].account / .price)");
      }
    }
  }

  private static String where(String offer, int index) {
    return "offer \"" + offer + "\" accepts[" + index + "]";
  }

  private PaymentOption resolveOption(String offer, int index, Accept accept) {
    String where = where(offer, index);
    Account account = null;
    String network;
    if (accept.account() != null && accept.network() != null) {
      throw new X402ConfigurationException(where + ": set either account or network, not both "
          + "(the account already names its network)");
    }
    if (accept.account() != null) {
      account = properties.accounts().get(accept.account());
      if (account == null) {
        throw new X402ConfigurationException(where + ": unknown account \"" + accept.account()
            + "\"; known accounts: " + properties.accounts().keySet());
      }
      network = account.network();
    } else if (accept.network() != null) {
      network = accept.network();
    } else {
      throw new X402ConfigurationException(where + ": needs an account or a network. If you "
          + "overrode one element of accepts from an environment variable, Spring replaced the "
          + "whole list: use a placeholder in YAML instead (price: \"${REPORT_PRICE:$0.50}\") or "
          + "set the whole list in SPRING_APPLICATION_JSON");
    }
    String scheme = first(accept.scheme(), account == null ? null : account.scheme(),
        properties.defaults().scheme(), "exact");
    Integer maxTimeout = accept.maxTimeoutSeconds() != null ? accept.maxTimeoutSeconds()
        : account != null && account.maxTimeoutSeconds() != null ? account.maxTimeoutSeconds()
        : Integer.valueOf(properties.defaults().maxTimeoutSeconds());
    String pin = Facilitator.normalize(first(accept.facilitator(),
        account == null ? null : account.facilitator(), properties.defaults().facilitator()));
    if (pin != null && !facilitators.contains(pin)) {
      throw new X402ConfigurationException(where + ": unknown facilitator \"" + pin
          + "\"; known identifiers: " + facilitators);
    }

    if (accept.payTo() != null && accept.payToRef() != null) {
      throw new X402ConfigurationException(where + ": set either pay-to or pay-to-ref, not both");
    }
    String payTo;
    String payToRef;
    if (accept.payTo() != null || accept.payToRef() != null) {
      payTo = accept.payTo();
      payToRef = accept.payToRef();
    } else {
      payTo = account == null ? null : account.payTo();
      payToRef = account == null ? null : account.payToRef();
    }
    if (accept.price() != null && accept.priceRef() != null) {
      throw new X402ConfigurationException(where + ": set either price or price-ref, not both");
    }
    if (accept.price() == null && accept.priceRef() == null) {
      throw new X402ConfigurationException(where + ": needs a price or a price-ref");
    }

    Map<String, Object> accountExtra = account == null || account.extra() == null ? Map.of()
        : account.extra();
    Map<String, Object> optionExtra = accept.extra() == null ? Map.of() : accept.extra();
    Object inherited = accountExtra.get(PaymentFlows.ASSET_TRANSFER_METHOD);
    Object requested = optionExtra.get(PaymentFlows.ASSET_TRANSFER_METHOD);
    if (inherited != null && requested != null && !inherited.equals(requested)) {
      throw new X402ConfigurationException(where + ": cannot change the assetTransferMethod \""
          + inherited + "\" inherited from account \"" + accept.account() + "\"; use an account "
          + "per transfer method");
    }
    Map<String, Object> merged = new LinkedHashMap<>(accountExtra);
    merged.putAll(optionExtra);
    Map<String, Object> priceExtra = accept.price() != null && !accept.price().isMoney()
        ? accept.price().extra() : Map.of();

    OptionDraft draft = new OptionDraft(offer, index, accept.account(), network, scheme,
        priceExtra, merged, payTo, payToRef, inherited == null ? null : inherited.toString(),
        maxTimeout);
    checkKeyCase(where, draft.extra());
    for (X402OptionContributor contributor : contributors) {
      try {
        contributor.contribute(draft);
      } catch (X402ConfigurationException e) {
        throw e;
      } catch (RuntimeException e) {
        throw new X402ConfigurationException(where + ": " + e.getMessage());
      }
    }
    if (draft.payTo() == null && draft.payToRef() == null) {
      throw new X402ConfigurationException(where + ": no pay-to or pay-to-ref; set it on the "
          + "account or on the accepts entry");
    }
    Map<String, Object> finalExtra = draft.extra();
    checkKeyCase(where, finalExtra);

    PaymentOption.Builder option = PaymentOption.builder().scheme(scheme).network(network)
        .maxTimeoutSeconds(maxTimeout).facilitator(pin);
    Map<String, Object> wireExtra = accept.price() != null ? finalExtra : draft.optionExtra();
    option.extra(wireExtra.isEmpty() ? null : restoreLists(wireExtra));
    if (draft.payTo() != null) {
      option.payTo(draft.payTo());
    } else {
      X402DynamicPayTo bean = payToRefs.apply(draft.payToRef());
      if (bean == null) {
        throw new X402ConfigurationException(where + ": no X402DynamicPayTo bean named \""
            + draft.payToRef() + "\"");
      }
      option.payTo(bean);
    }
    if (accept.price() != null) {
      option.price(staticPrice(where, accept.price(), network, scheme));
    } else {
      X402DynamicPrice bean = priceRefs.apply(accept.priceRef());
      if (bean == null) {
        throw new X402ConfigurationException(where + ": no X402DynamicPrice bean named \""
            + accept.priceRef() + "\"");
      }
      Object method = finalExtra.get(PaymentFlows.ASSET_TRANSFER_METHOD);
      option.price(guarded(accept.priceRef(), bean, method == null ? null : method.toString()));
    }
    return option.build();
  }

  private Price staticPrice(String where, PriceSpec spec, String network, String scheme) {
    Price price;
    try {
      price = spec.toPrice();
    } catch (IllegalArgumentException e) {
      throw new X402ConfigurationException(where + ": " + e.getMessage());
    }
    SchemeNetworkServer registered = server == null ? null
        : server.getRegisteredScheme(network, scheme);
    if (registered != null) {
      try {
        registered.parsePrice(price, network);
      } catch (RuntimeException e) {
        throw new X402ConfigurationException(where + ": price \"" + spec + "\" cannot be used on "
            + network + ": " + e.getMessage());
      }
    }
    return price;
  }

  /** Rule 6: a dynamic price may not switch the transfer method resolved at startup. */
  private static DynamicPrice guarded(String name, DynamicPrice bean, String startupMethod) {
    return (HttpRequestContext context) -> {
      Price price = bean.resolve(context);
      if (price instanceof AssetAmount amount && amount.extra() != null) {
        Object dynamic = amount.extra().get(PaymentFlows.ASSET_TRANSFER_METHOD);
        if (dynamic != null && !sameMethod(startupMethod, dynamic.toString())) {
          throw new IllegalStateException("x402: price-ref \"" + name + "\" returned "
              + "assetTransferMethod \"" + dynamic + "\" but the option was resolved with \""
              + (startupMethod == null ? PaymentFlows.SDK_DEFAULT_ASSET_TRANSFER_METHOD
                  : startupMethod) + "\" at startup; refused");
        }
      }
      return price;
    };
  }

  private static boolean sameMethod(String startup, String dynamic) {
    String effective = startup == null ? PaymentFlows.SDK_DEFAULT_ASSET_TRANSFER_METHOD : startup;
    return effective.equals(dynamic);
  }

  private static void checkKeyCase(String where, Map<String, Object> extra) {
    for (String key : extra.keySet()) {
      for (String protocol : PROTOCOL_KEYS) {
        if (!key.equals(protocol) && key.toLowerCase(Locale.ROOT)
            .equals(protocol.toLowerCase(Locale.ROOT))) {
          throw new X402ConfigurationException(where + ": extra key \"" + key + "\" differs from "
              + "the protocol key \"" + protocol + "\" only by case (environment variables "
              + "lowercase map keys); set extra from YAML or SPRING_APPLICATION_JSON");
        }
      }
    }
  }

  private RouteConfig route(Offer offer, List<PaymentOption> options) {
    boolean failover = offer.failover() != null ? offer.failover()
        : properties.defaults().failover();
    return RouteConfig.builder().accepts(options).resource(offer.resource())
        .description(offer.description()).mimeType(offer.mimeType())
        .serviceName(offer.serviceName()).tags(offer.tags()).iconUrl(offer.iconUrl())
        .customPaywallHtml(offer.customPaywallHtml())
        .extensions(offer.extensions() == null ? null : restoreLists(offer.extensions()))
        .failover(failover).build();
  }

  /** Restores the lists YAML binds as index-keyed maps in every value (not in the keys). */
  private static Map<String, Object> restoreLists(Map<String, Object> values) {
    Map<String, Object> out = new LinkedHashMap<>();
    values.forEach((k, v) -> out.put(k, RawProperties.restoreLists(v)));
    return out;
  }

  private static String first(String... values) {
    for (String v : values) {
      if (v != null && !v.isBlank()) {
        return v;
      }
    }
    return null;
  }
}
