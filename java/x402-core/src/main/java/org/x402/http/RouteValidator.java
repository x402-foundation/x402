package org.x402.http;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.x402.core.FacilitatorClient;
import org.x402.core.PaymentFlow;
import org.x402.core.SchemeNetworkServer;
import org.x402.core.server.PaymentFlows;
import org.x402.core.server.RoutingSnapshot;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.SupportedKind;
import org.x402.core.utils.JsonValues;
import org.x402.core.utils.Networks;
import org.x402.http.RouteValidationError.Reason;

/**
 * The route checks of {@link X402HttpResourceServer}: before any facilitator sync (transfer
 * methods, payment flows, pins) and after each sync (schemes, facilitator capabilities, ambiguous
 * options and the client time budget). Errors stop startup; warnings are logged.
 */
final class RouteValidator {

  private static final System.Logger LOG =
      System.getLogger(X402HttpResourceServer.class.getName());
  private static final Duration CLIENT_BUDGET = X402HttpClient.DEFAULT_REQUEST_TIMEOUT;

  /** What one validation found. */
  record Result(List<RouteValidationError> errors, List<String> warnings) {}

  private final X402ResourceServer server;
  private final RouteResolver resolver;

  RouteValidator(X402ResourceServer server, RouteResolver resolver) {
    this.server = server;
    this.resolver = resolver;
  }

  /** The checks that need no facilitator answer. */
  List<RouteValidationError> beforeSync() {
    List<RouteValidationError> errors = new ArrayList<>();
    resolver.routes().forEach((key, config) -> validateOptions(key, config, null, errors));
    return errors;
  }

  /** Every check against a synced snapshot. */
  Result validate(RoutingSnapshot snapshot) {
    List<RouteValidationError> errors = new ArrayList<>();
    List<String> warnings = new ArrayList<>();
    resolver.routes().forEach((key, config) -> {
      warnWildcardBazaar(key, config, warnings);
      validateOptions(key, config, snapshot, errors);
      capabilityProblems(key, config, snapshot, errors);
      checkAmbiguity(key, config, snapshot, errors);
      checkBudget(key, config, snapshot, warnings);
    });
    // Kinds some option uses are checked per option with that option's build facilitator above;
    // a core-level problem matters only for a registered kind no option uses (fatal).
    for (X402ResourceServer.CapabilityProblem problem
        : server.facilitatorCapabilityProblems(snapshot)) {
      if (!kindUsed(problem.scheme(), problem.network())) {
        errors.add(new RouteValidationError(null, problem.scheme(), problem.network(),
            Reason.FACILITATOR_CAPABILITY, problem.line(), null, problem.facilitator(), false));
      }
    }
    return new Result(errors, warnings);
  }

  /**
   * Checks one route's options against the registered schemes, flows and pins. With {@code snapshot
   * == null} (constructor) only methods, flows and unknown pins are checked; missing schemes are
   * skipped.
   */
  private void validateOptions(String key, RouteConfig config, RoutingSnapshot snapshot,
      List<RouteValidationError> errors) {
    List<PaymentOption> options = config.accepts();
    for (int i = 0; i < options.size(); i++) {
      PaymentOption option = options.get(i);
      SchemeNetworkServer scheme = server.getRegisteredScheme(option.network(), option.scheme());
      if (option.facilitator() != null && server.facilitator(option.facilitator()) == null) {
        errors.add(new RouteValidationError(key, option.scheme(), option.network(),
            Reason.UNKNOWN_FACILITATOR, "Route \"" + key + "\" option " + i
                + ": unknown facilitator \"" + option.facilitator() + "\"; known: "
                + String.join(", ", server.facilitatorIdentifiers()), i, option.facilitator(),
            false));
      }
      if (scheme == null) {
        if (snapshot != null) {
          errors.add(new RouteValidationError(key, option.scheme(), option.network(),
              Reason.MISSING_SCHEME, "Route \"" + key + "\": No scheme implementation registered "
                  + "for \"" + option.scheme() + "\" on network \"" + option.network() + "\"", i,
              null, false));
        }
        continue;
      }
      Object method = option.extra() == null ? null : option.extra().get(
          PaymentFlows.ASSET_TRANSFER_METHOD);
      String atm = method instanceof String s ? s : scheme.defaultAssetTransferMethod();
      if (!scheme.paymentFlows().containsKey(atm)) {
        errors.add(new RouteValidationError(key, option.scheme(), option.network(),
            Reason.UNSUPPORTED_ASSET_TRANSFER_METHOD, "Route \"" + key + "\": [x402] Scheme \""
                + scheme.scheme() + "\" does not support assetTransferMethod \"" + atm
                + "\". Supported: " + String.join(", ", scheme.paymentFlows().keySet()) + ".", i,
            null, false));
        continue;
      }
      try {
        PaymentFlows.resolve(scheme, option.extra());
      } catch (IllegalArgumentException e) {
        errors.add(new RouteValidationError(key, option.scheme(), option.network(),
            Reason.UNSUPPORTED_PAYMENT_FLOW, "Route \"" + key + "\": " + e.getMessage(), i, null,
            false));
      }
      Map<String, Object> extra = staticExtra(scheme, option);
      String invalid = extra == null ? null : scheme.validateOption(option.network(), extra);
      if (invalid != null) {
        errors.add(new RouteValidationError(key, option.scheme(), option.network(),
            Reason.INVALID_OPTION, "Route \"" + key + "\" option " + i + ": " + scheme.scheme()
                + " on " + option.network() + ": " + invalid, i, null, false));
      }
      if (snapshot == null || (option.facilitator() != null
          && server.facilitator(option.facilitator()) == null)) {
        continue;
      }
      String pin = pin(option);
      if (pin != null) {
        if (snapshot.kindOf(pin, X402ResourceServer.X402_VERSION, option.network(),
            scheme.scheme()) == null) {
          errors.add(new RouteValidationError(key, option.scheme(), option.network(),
              Reason.MISSING_FACILITATOR, "Route \"" + key + "\" option " + i
                  + ": pinned facilitator \"" + pin + "\" does not support scheme \""
                  + option.scheme() + "\" on network \"" + option.network() + "\"", i, pin,
              snapshot.failures().containsKey(pin)));
        }
      } else if (snapshot.supportedKind(X402ResourceServer.X402_VERSION, option.network(),
          option.scheme()) == null) {
        errors.add(new RouteValidationError(key, option.scheme(), option.network(),
            Reason.MISSING_FACILITATOR, "Route \"" + key + "\": Facilitator does not support "
                + "scheme \"" + option.scheme() + "\" on network \"" + option.network() + "\"", i,
            null, !snapshot.failures().isEmpty()));
      }
    }
  }

  private boolean kindUsed(String scheme, String networkKey) {
    return resolver.routes().values().stream().flatMap(c -> c.accepts().stream())
        .anyMatch(o -> o.scheme().equals(scheme)
            && Networks.matchesPattern(networkKey, o.network()));
  }

  /**
   * Whether an error that depends on kind ownership may heal: some facilitator failed and the
   * option is unpinned (a recovered facilitator may own its kind) or its pin is the one that failed.
   */
  private static boolean mayHeal(RoutingSnapshot snapshot, PaymentOption option, String pin) {
    return !snapshot.failures().isEmpty()
        && (option.facilitator() == null || snapshot.failures().containsKey(pin));
  }

  /** Per-option {@code validateFacilitatorSupport} with the build facilitator's kind. */
  private void capabilityProblems(String key, RouteConfig config, RoutingSnapshot snapshot,
      List<RouteValidationError> errors) {
    List<PaymentOption> options = config.accepts();
    for (int i = 0; i < options.size(); i++) {
      PaymentOption option = options.get(i);
      SchemeNetworkServer scheme = server.getRegisteredScheme(option.network(), option.scheme());
      String build = buildFacilitator(option, snapshot);
      if (scheme == null || build == null) {
        continue;
      }
      SupportedKind kind = snapshot.kindOf(build, X402ResourceServer.X402_VERSION,
          option.network(), scheme.scheme());
      if (kind == null) {
        continue;
      }
      List<String> extensions = snapshot.extensions(build);
      String problem = scheme.validateFacilitatorSupport(option.network(), kind, extensions,
          staticExtra(scheme, option));
      if (problem != null) {
        String line = scheme.scheme() + " on " + option.network() + ": " + problem;
        errors.add(new RouteValidationError(key, option.scheme(), option.network(),
            Reason.FACILITATOR_CAPABILITY, "Route \"" + key + "\" option " + i + ": " + line
                + " (facilitator \"" + build + "\")", i, build,
            mayHeal(snapshot, option, pin(option))));
      }
    }
  }

  /**
   * The {@code extra} a request would build for an option with a static price: the price's
   * {@code extra} below the option's. {@code null} for a dynamic or unparsable price, whose
   * {@code extra} is only known per request.
   */
  private static Map<String, Object> staticExtra(SchemeNetworkServer scheme, PaymentOption option) {
    if (option.price() == null || option.priceResolver() != null) {
      return null;
    }
    try {
      AssetAmount price = scheme.parsePrice(option.price(), option.network());
      return PaymentFlows.mergeExtra(price.extra(), option.extra());
    } catch (RuntimeException e) {
      return null;
    }
  }

  /**
   * Ambiguity check: two options with a different routing policy whose core fields
   * may be equal and whose {@code extra} is compatible could both match one payment.
   */
  private void checkAmbiguity(String key, RouteConfig config, RoutingSnapshot snapshot,
      List<RouteValidationError> errors) {
    List<PaymentOption> options = config.accepts();
    for (int i = 0; i < options.size(); i++) {
      for (int j = i + 1; j < options.size(); j++) {
        PaymentOption a = options.get(i);
        PaymentOption b = options.get(j);
        if (!knownPin(a) || !knownPin(b)) {
          continue;
        }
        String policyA = policy(a, config, snapshot);
        String policyB = policy(b, config, snapshot);
        if (policyA.equals(policyB) || !mayOverlap(a, b)) {
          continue;
        }
        errors.add(new RouteValidationError(key, a.scheme(), a.network(),
            Reason.AMBIGUOUS_OPTIONS, "Route \"" + key + "\": options " + i + " and " + j
                + " can match the same payment but route to different facilitators ("
                + policyA + " vs " + policyB + "); make a payment term differ (network, asset, "
                + "amount, payTo, maxTimeoutSeconds or a shared extra key) or use the same "
                + "facilitator", i, null,
            mayHeal(snapshot, a, pin(a)) || mayHeal(snapshot, b, pin(b))));
      }
    }
  }

  private boolean knownPin(PaymentOption option) {
    return option.facilitator() == null || server.facilitator(option.facilitator()) != null;
  }

  private String policy(PaymentOption option, RouteConfig config, RoutingSnapshot snapshot) {
    String build = buildFacilitator(option, snapshot);
    String policy = build == null ? "<none>" : "\"" + build + "\"";
    if (config.failover()) {
      policy += option.facilitator() != null ? " pinned" : " unpinned";
    }
    return policy;
  }

  private boolean mayOverlap(PaymentOption a, PaymentOption b) {
    if (!a.scheme().equals(b.scheme()) || !a.network().equals(b.network())
        || a.effectiveMaxTimeoutSeconds() != b.effectiveMaxTimeoutSeconds()) {
      return false;
    }
    if (a.payTo() != null && b.payTo() != null && !a.payTo().equals(b.payTo())) {
      return false;
    }
    AssetAmount priceA = staticPrice(a);
    AssetAmount priceB = staticPrice(b);
    if (priceA != null && priceB != null && (!Objects.equals(priceA.asset(), priceB.asset())
        || !Objects.equals(priceA.amount(), priceB.amount()))) {
      return false;
    }
    SchemeNetworkServer scheme = server.getRegisteredScheme(a.network(), a.scheme());
    List<String> dynamic = scheme == null ? List.of() : scheme.dynamicExtraFields();
    return compatible(JsonValues.omit(wireExtra(scheme, finalExtra(a, priceA)), dynamic),
        JsonValues.omit(wireExtra(scheme, finalExtra(b, priceB)), dynamic));
  }

  /**
   * The {@code extra} as it goes on the wire and is matched: the SDK {@code "default"} transfer
   * method is dropped and a non-authorization flow is announced.
   */
  private static Map<String, Object> wireExtra(SchemeNetworkServer scheme,
      Map<String, Object> extra) {
    if (scheme == null) {
      return extra;
    }
    try {
      return PaymentFlows.applyWireExtra(extra, PaymentFlows.resolve(scheme, extra));
    } catch (IllegalArgumentException e) {
      return extra;
    }
  }

  private AssetAmount staticPrice(PaymentOption option) {
    if (option.price() == null) {
      return null;
    }
    SchemeNetworkServer scheme = server.getRegisteredScheme(option.network(), option.scheme());
    if (scheme == null) {
      return null;
    }
    try {
      return scheme.parsePrice(option.price(), option.network());
    } catch (RuntimeException e) {
      return null;
    }
  }

  private static Map<String, Object> finalExtra(PaymentOption option, AssetAmount price) {
    return PaymentFlows.mergeExtra(price == null ? null : price.extra(), option.extra());
  }

  @SuppressWarnings("unchecked")
  private static boolean compatible(Map<String, Object> a, Map<String, Object> b) {
    for (Map.Entry<String, Object> e : a.entrySet()) {
      if (!b.containsKey(e.getKey())) {
        continue;
      }
      Object other = b.get(e.getKey());
      if (e.getValue() instanceof Map && other instanceof Map) {
        if (!compatible((Map<String, Object>) e.getValue(), (Map<String, Object>) other)) {
          return false;
        }
      } else if (!JsonValues.deepEqual(e.getValue(), other)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Timeout budget: build verify-timeout + (failover ? largest candidate
   * verify-timeout : 0) + n × largest settle timeout of the possible settle targets, where n is 2
   * (one settle and its pending retry) or 4 for escrow, which settles before and after the
   * handler.
   */
  private void checkBudget(String key, RouteConfig config, RoutingSnapshot snapshot,
      List<String> warnings) {
    List<PaymentOption> options = config.accepts();
    for (int i = 0; i < options.size(); i++) {
      PaymentOption option = options.get(i);
      String build = knownPin(option) ? buildFacilitator(option, snapshot) : null;
      if (build == null) {
        continue;
      }
      FacilitatorClient buildClient = server.facilitator(build);
      Duration verify = buildClient.verifyTimeout();
      Duration failover = Duration.ZERO;
      Duration settle = buildClient.settleTimeout();
      if (config.failover() && option.facilitator() == null) {
        for (String candidate : candidates(build, option, snapshot)) {
          FacilitatorClient c = server.facilitator(candidate);
          failover = max(failover, c.verifyTimeout());
          settle = max(settle, c.settleTimeout());
        }
      }
      int settles = settlesPerPayment(option);
      Duration worst = verify.plus(failover).plus(settle.multipliedBy(settles));
      if (worst.compareTo(CLIENT_BUDGET) > 0) {
        warnings.add("Route \"" + key + "\" option " + i + ": the worst-case payment path takes "
            + worst.toSeconds() + " s (verify " + verify.toSeconds() + " s + failover verify "
            + failover.toSeconds() + " s + " + settles + " × settle " + settle.toSeconds()
            + " s), above the " + CLIENT_BUDGET.toSeconds() + " s client default timeout");
      }
    }
  }

  private int settlesPerPayment(PaymentOption option) {
    SchemeNetworkServer scheme = server.getRegisteredScheme(option.network(), option.scheme());
    if (scheme == null) {
      return 2;
    }
    try {
      PaymentFlow flow = PaymentFlows.resolve(scheme, finalExtra(option, null)).flow();
      return flow.settleBeforeHandler() && flow.settleAfterHandler() ? 4 : 2;
    } catch (IllegalArgumentException e) {
      return 2;
    }
  }

  private List<String> candidates(String build, PaymentOption option, RoutingSnapshot snapshot) {
    return server.failoverCandidates(snapshot, build, X402ResourceServer.X402_VERSION,
        option.network(), option.scheme());
  }


  private static Duration max(Duration a, Duration b) {
    return a.compareTo(b) >= 0 ? a : b;
  }

  private void warnWildcardBazaar(String key, RouteConfig config, List<String> warnings) {
    String pathPart = key.contains(" ") ? key.split("\\s+", -1)[1] : key;
    if (pathPart.contains("*") && config.extensions() != null
        && config.extensions().containsKey("bazaar")) {
      warnings.add("[x402] Route \"" + key + "\": Wildcard (*) patterns with bazaar discovery "
          + "extensions will auto-generate parameter names (var1, var2, ...). Consider using "
          + "named parameters instead (e.g. /weather/:city) for better discovery metadata.");
    }
  }

  private String buildFacilitator(PaymentOption option, RoutingSnapshot snapshot) {
    String pin = pin(option);
    if (pin != null) {
      return pin;
    }
    return snapshot.owner(X402ResourceServer.X402_VERSION, option.network(), option.scheme());
  }

  private String pin(PaymentOption option) {
    if (option.facilitator() == null) {
      return null;
    }
    String id = X402ResourceServer.normalizeIdentifier(option.facilitator());
    return server.facilitator(id) == null ? null : id;
  }
}
