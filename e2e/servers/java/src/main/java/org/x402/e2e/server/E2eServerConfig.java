package org.x402.e2e.server;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Function;
import org.x402.e2e.server.accounts.E2eNetworkAccounts;
import org.x402.e2e.server.accounts.impl.CardanoE2eAccounts;

/**
 * Turns the e2e catalog and the harness environment into Spring properties for the x402 starter
 * ({@code x402.facilitators}, {@code x402.accounts}, {@code x402.routes}), with the routes the
 * catalog lists for the Java SDK.
 *
 * <ul>
 *   <li>One account per (network, transfer method), e.g. {@code cardano}, {@code cardano-script}.
 *       The transfer method sits on the account. By default an account pays to {@code
 *       SERVER_<ID>_ADDRESS}; a network that needs more adds an {@link E2eNetworkAccounts}
 *       implementation to {@link #networkAccounts} (Cardano: {@link CardanoE2eAccounts}).
 *   <li>One offer per catalog route with one {@code accepts} entry. The catalog {@code extra}
 *       (script block, {@code paymentFlow}, requirements/scheme extra) goes into that entry's
 *       {@code extra}; there is no offer-level {@code extra}.
 *   <li>The first mounted plain route (scheme {@code exact}, no transfer method or {@code
 *       default}) is served by an {@code @X402Payment} controller as offer {@link #ANNOTATED_OFFER}
 *       at {@link #ANNOTATED_PATH_PROPERTY} (no {@code path:}), so the annotation path runs on
 *       whichever network is configured. Every other route gets {@code path: "GET <path>"} and a
 *       catalog-driven handler.
 * </ul>
 */
public final class E2eServerConfig {

  /** The fixed success body message of every paid route. */
  public static final String PROTECTED_ROUTE_MESSAGE = "Protected endpoint accessed successfully";

  /** The offer name of the annotated route, used by {@code @X402Payment}. */
  public static final String ANNOTATED_OFFER = "e2e-annotated";

  /** Property holding the annotated route's path, used by the controller's {@code @GetMapping}. */
  public static final String ANNOTATED_PATH_PROPERTY = "e2e.annotated-path";

  /** Property listing the paths that need the catalog-driven handler (comma-separated). */
  public static final String CATALOG_PATHS_PROPERTY = "e2e.catalog-paths";

  /** Property set to {@code true} when an annotated route is served. */
  public static final String ANNOTATED_ROUTE_PROPERTY = "e2e.annotated-route";

  private final Map<String, Object> properties;
  private final List<String> mountedPaths;
  private final List<String> skipped;

  private E2eServerConfig(Map<String, Object> properties, List<String> mountedPaths,
      List<String> skipped) {
    this.properties = properties;
    this.mountedPaths = mountedPaths;
    this.skipped = skipped;
  }

  /**
   * Builds the properties from the process environment.
   *
   * @return the configuration
   */
  public static E2eServerConfig fromEnvironment() {
    return build(System::getenv);
  }

  /**
   * Builds the properties.
   *
   * @param env environment lookup
   * @return the configuration
   */
  public static E2eServerConfig build(Function<String, String> env) {
    E2eCatalog catalog = E2eCatalog.load(env);
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("server.port", E2eEnv.envOr(env, "PORT", "4021"));

    String facilitatorUrl = env.apply("FACILITATOR_URL");
    if (E2eEnv.isBlank(facilitatorUrl)) {
      throw new IllegalStateException("FACILITATOR_URL environment variable is required");
    }
    p.put("x402.facilitators[0].url", facilitatorUrl.trim());
    String mock = env.apply("MOCK_FACILITATOR_URL");
    if (!E2eEnv.isBlank(mock)) {
      p.put("x402.facilitators[1].url", mock.trim());
    }

    // Built before the loop so their env is validated even when none of their routes is mounted.
    Map<String, E2eNetworkAccounts> networkAccounts = networkAccounts(env);
    String annotatedPath = null;
    List<String> mounted = new ArrayList<>();
    List<String> catalogPaths = new ArrayList<>();
    List<String> skipped = new ArrayList<>();
    Map<String, Boolean> accounts = new LinkedHashMap<>();

    for (E2eCatalog.Route route : catalog.routes()) {
      E2eCatalog.Network network = catalog.network(route.network());
      String serverPayTo = env.apply("SERVER_" + route.network().toUpperCase(Locale.ROOT)
          + "_ADDRESS");
      if (E2eEnv.isBlank(serverPayTo)) {
        skipped.add(route.path() + " (no SERVER_" + route.network().toUpperCase(Locale.ROOT)
            + "_ADDRESS)");
        continue;
      }
      if (route.settlementOverride()) {
        throw new IllegalStateException("route " + route.path()
            + ": settlementOverride is not supported by the Java e2e server");
      }
      String caip2 = E2eEnv.envOr(env, route.network().toUpperCase(Locale.ROOT) + "_NETWORK",
          network.testnetCaip2());
      E2eNetworkAccounts hooks =
          networkAccounts.getOrDefault(route.network(), E2eNetworkAccounts.DEFAULT);
      String skipReason = hooks.skipReason(route);
      if (skipReason != null) {
        skipped.add(route.path() + " (" + skipReason + ")");
        continue;
      }
      String method = route.assetTransferMethod();

      String account = method == null || "default".equals(method)
          ? route.network() : route.network() + "-" + method;
      if (accounts.putIfAbsent(account, Boolean.TRUE) == null) {
        String a = "x402.accounts." + account + ".";
        p.put(a + "network", caip2);
        hooks.putAccount(p, a, method, serverPayTo.trim());
        if (method != null && !"default".equals(method)) {
          p.put(a + "extra.assetTransferMethod", method);
        }
      }

      boolean annotated = annotatedPath == null && "exact".equals(route.scheme())
          && (method == null || "default".equals(method));
      String offer = annotated ? ANNOTATED_OFFER : offerName(route.path());
      String o = "x402.routes." + offer + ".";
      String accept = o + "accepts[0].";
      p.put(accept + "account", account);
      if (!"exact".equals(route.scheme())) {
        p.put(accept + "scheme", route.scheme());
      }
      putPrice(p, accept, route, env);
      if (route.maxTimeoutSeconds() != null) {
        p.put(accept + "max-timeout-seconds", route.maxTimeoutSeconds());
      }
      if (route.requirementsExtra() != null) {
        flatten(p, accept + "extra", route.requirementsExtra());
      }
      hooks.putAcceptExtra(p, accept, method);
      if (route.paymentFlow() != null && !"authorization".equals(route.paymentFlow())) {
        p.put(accept + "extra.paymentFlow", route.paymentFlow());
      }
      if (route.schemeExtra() != null) {
        flatten(p, accept + "extra", route.schemeExtra());
      }
      for (String extension : route.extensions()) {
        if (!"bazaar".equals(extension)) {
          throw new IllegalStateException("route " + route.path() + " declares extension \""
              + extension + "\", which the Java e2e server does not declare");
        }
        putBazaar(p, o + "extensions.bazaar.");
      }

      if (annotated) {
        annotatedPath = route.path();
        p.put(ANNOTATED_ROUTE_PROPERTY, "true");
        p.put(ANNOTATED_PATH_PROPERTY, route.path());
      } else {
        p.put(o + "path", "GET " + route.path());
        catalogPaths.add(route.path());
      }
      mounted.add(route.path());
    }
    p.put(CATALOG_PATHS_PROPERTY, String.join(",", catalogPaths));
    return new E2eServerConfig(Map.copyOf(p), List.copyOf(mounted), List.copyOf(skipped));
  }

  /**
   * The networks that need more than a pay-to address, by catalog network id. Add a network here
   * with its {@link E2eNetworkAccounts} implementation.
   *
   * @param env environment lookup
   * @return the accounts by network id
   */
  private static Map<String, E2eNetworkAccounts> networkAccounts(Function<String, String> env) {
    return Map.of("cardano", new CardanoE2eAccounts(env));
  }

  /**
   * The Spring properties (use as {@code SpringApplication} default properties).
   *
   * @return the properties
   */
  public Map<String, Object> properties() {
    return properties;
  }

  /**
   * The paid paths this server mounts.
   *
   * @return the paths
   */
  public List<String> mountedPaths() {
    return mountedPaths;
  }

  /**
   * Catalog routes left out, with the reason.
   *
   * @return the routes
   */
  public List<String> skipped() {
    return skipped;
  }

  /**
   * The offer name of a catalog path: {@code /exact/cardano/default} → {@code
   * exact-cardano-default}.
   *
   * @param path the route path
   * @return the offer name
   */
  public static String offerName(String path) {
    String name = path.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-")
        .replaceAll("^-+|-+$", "");
    return name.isEmpty() ? "root" : name;
  }

  /**
   * The success body of every paid route.
   *
   * @return the body
   */
  public static Map<String, Object> successBody() {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("message", PROTECTED_ROUTE_MESSAGE);
    body.put("timestamp", java.time.Instant.now().toString());
    return body;
  }

  private static void putPrice(Map<String, Object> p, String accept, E2eCatalog.Route route,
      Function<String, String> env) {
    E2eCatalog.Price price = route.price();
    if (price.usd() != null) {
      p.put(accept + "price", price.usd());
      return;
    }
    String amount = price.amountEnv() == null ? null : env.apply(price.amountEnv());
    amount = E2eEnv.isBlank(amount) ? price.amount() : amount.trim();
    String asset = price.assetEnv() == null ? null : env.apply(price.assetEnv());
    asset = E2eEnv.isBlank(asset) ? price.asset() : asset.trim();
    if (amount == null || asset == null) {
      throw new IllegalStateException("route " + route.path() + ": price has no amount/asset");
    }
    p.put(accept + "price.amount", amount);
    p.put(accept + "price.asset", asset);
  }

  /** Bazaar discovery output declared for the protected route. */
  private static void putBazaar(Map<String, Object> p, String b) {
    p.put(b + "output.example.message", PROTECTED_ROUTE_MESSAGE);
    p.put(b + "output.example.timestamp", "2024-01-01T00:00:00Z");
    p.put(b + "output.schema.properties.message.type", "string");
    p.put(b + "output.schema.properties.timestamp.type", "string");
    p.put(b + "output.schema.required[0]", "message");
    p.put(b + "output.schema.required[1]", "timestamp");
  }

  private static void flatten(Map<String, Object> p, String prefix, JsonNode node) {
    if (node.isObject()) {
      Iterator<Map.Entry<String, JsonNode>> it = node.fields();
      while (it.hasNext()) {
        Map.Entry<String, JsonNode> e = it.next();
        flatten(p, prefix + "." + e.getKey(), e.getValue());
      }
    } else if (node.isArray()) {
      // One List value: index-keyed properties would bind as a map {"0": …, "1": …} under
      // Map<String, Object>, while a List value passes through as a JSON array.
      p.put(prefix, new com.fasterxml.jackson.databind.ObjectMapper().convertValue(node,
          java.util.List.class));
    } else if (node.isBoolean()) {
      p.put(prefix, node.booleanValue());
    } else if (node.isIntegralNumber()) {
      // Keep JSON scalar types: default properties hold Objects, and Map<String, Object>
      // binding passes them through, so extra stays {"x": 1} rather than {"x": "1"}.
      p.put(prefix, node.canConvertToLong() ? (Object) node.longValue() : node.bigIntegerValue());
    } else if (node.isNumber()) {
      p.put(prefix, node.decimalValue());
    } else if (!node.isNull()) {
      p.put(prefix, node.asText());
    }
  }
}
