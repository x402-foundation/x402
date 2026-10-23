package org.x402.e2e.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Reads the e2e mechanisms catalog (`e2e/config/mechanisms_*.json`): the harness passes the
 * directory in {@code E2E_MECHANISMS_CATALOG}, otherwise the loader walks up from the working
 * directory to {@code config/mechanisms_global.json}.
 */
public final class E2eCatalog {

  /** The SDK id the Java components are listed under in route {@code sdks}. */
  public static final String SDK = "java";

  private static final Pattern NETWORK_FILE = Pattern.compile("^mechanisms_(.+)\\.json$");

  /** One network file's identity. */
  public record Network(String id, String testnetCaip2, String mainnetCaip2, String rpcUrlDefault) {}

  /** Declarative price of a route (amount form only; Java routes are priced in atomic units). */
  public record Price(String usd, String amount, String amountEnv, String asset, String assetEnv) {}

  /** One catalog route this SDK implements. */
  public record Route(
      String path,
      String network,
      String scheme,
      String assetTransferMethod,
      String paymentFlow,
      Integer maxTimeoutSeconds,
      Price price,
      List<String> extensions,
      JsonNode requirementsExtra,
      JsonNode schemeExtra,
      boolean settlementOverride) {}

  private final Map<String, Network> networks;
  private final List<Route> routes;

  private E2eCatalog(Map<String, Network> networks, List<Route> routes) {
    this.networks = networks;
    this.routes = routes;
  }

  /**
   * Loads the catalog and keeps the routes listing {@link #SDK}, minus the harness exclusions
   * ({@code E2E_EXCLUDE_SCHEMES}, {@code E2E_EXCLUDE_NETWORKS}) and env-gated routes.
   *
   * @param env environment lookup
   * @return the catalog
   */
  public static E2eCatalog load(Function<String, String> env) {
    Path dir = catalogDir(env);
    ObjectMapper mapper = new ObjectMapper();
    Map<String, Network> networks = new TreeMap<>();
    List<Route> routes = new ArrayList<>();
    Set<String> excludedSchemes = csv(env.apply("E2E_EXCLUDE_SCHEMES"));
    Set<String> excludedNetworks = csv(env.apply("E2E_EXCLUDE_NETWORKS"));
    List<Path> files = new ArrayList<>();
    try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir, "mechanisms_*.json")) {
      stream.forEach(files::add);
    } catch (IOException e) {
      throw new IllegalStateException("cannot list catalog directory " + dir, e);
    }
    files.sort(null);
    for (Path file : files) {
      Matcher m = NETWORK_FILE.matcher(file.getFileName().toString());
      if (!m.matches() || m.group(1).equals("global")) {
        continue;
      }
      String id = m.group(1);
      JsonNode root;
      try {
        root = mapper.readTree(file.toFile());
      } catch (IOException e) {
        throw new IllegalStateException("cannot read " + file, e);
      }
      networks.put(id, new Network(id,
          root.path("testnet").path("caip2").asText(null),
          root.path("mainnet").path("caip2").asText(null),
          root.path("testnet").path("rpcUrlDefault").asText(null)));
      Iterator<Map.Entry<String, JsonNode>> it = root.path("routes").fields();
      while (it.hasNext()) {
        Map.Entry<String, JsonNode> entry = it.next();
        JsonNode def = entry.getValue();
        if (!contains(def.path("sdks"), SDK)) {
          continue;
        }
        String scheme = def.path("scheme").asText();
        if (excludedSchemes.contains(scheme) || excludedNetworks.contains(id)) {
          continue;
        }
        String requiresEnv = text(def, "requiresEnv");
        if (requiresEnv != null && E2eEnv.isBlank(env.apply(requiresEnv))) {
          continue;
        }
        String requiresEnvAbsent = text(def, "requiresEnvAbsent");
        if (requiresEnvAbsent != null && !E2eEnv.isBlank(env.apply(requiresEnvAbsent))) {
          continue;
        }
        JsonNode price = def.path("price");
        List<String> extensions = new ArrayList<>();
        def.path("extensions").forEach(n -> extensions.add(n.asText()));
        routes.add(new Route(
            entry.getKey(),
            id,
            scheme,
            text(def, "assetTransferMethod"),
            text(def, "paymentFlow"),
            def.hasNonNull("maxTimeoutSeconds") ? def.get("maxTimeoutSeconds").asInt() : null,
            new Price(text(price, "usd"), text(price, "amount"), text(price, "amountEnv"),
                text(price, "asset"), text(price, "assetEnv")),
            List.copyOf(extensions),
            def.get("requirementsExtra"),
            def.get("schemeExtra"),
            def.has("settlementOverride")));
      }
    }
    return new E2eCatalog(Map.copyOf(networks), List.copyOf(routes));
  }

  /**
   * The routes listing this SDK, in file order.
   *
   * @return the routes
   */
  public List<Route> routes() {
    return routes;
  }

  /**
   * A network's identity.
   *
   * @param id the catalog network id, e.g. {@code cardano}
   * @return the network
   */
  public Network network(String id) {
    Network network = networks.get(id);
    if (network == null) {
      throw new IllegalStateException("unknown catalog network " + id);
    }
    return network;
  }

  private static Path catalogDir(Function<String, String> env) {
    String injected = env.apply("E2E_MECHANISMS_CATALOG");
    if (!E2eEnv.isBlank(injected)) {
      Path dir = Path.of(injected);
      if (!Files.isDirectory(dir)) {
        throw new IllegalStateException("E2E_MECHANISMS_CATALOG does not point at a directory: "
            + injected);
      }
      return dir;
    }
    Path dir = Path.of("").toAbsolutePath();
    while (dir != null) {
      if (Files.isRegularFile(dir.resolve("config").resolve("mechanisms_global.json"))) {
        return dir.resolve("config");
      }
      dir = dir.getParent();
    }
    throw new IllegalStateException("could not locate e2e/config/mechanisms_global.json");
  }

  private static boolean contains(JsonNode array, String value) {
    for (JsonNode n : array) {
      if (value.equals(n.asText())) {
        return true;
      }
    }
    return false;
  }

  private static String text(JsonNode node, String field) {
    JsonNode v = node.get(field);
    return v == null || v.isNull() ? null : v.asText();
  }

  private static Set<String> csv(String raw) {
    if (E2eEnv.isBlank(raw)) {
      return Set.of();
    }
    return Arrays.stream(raw.split(",")).map(String::trim).filter(s -> !s.isEmpty())
        .collect(Collectors.toUnmodifiableSet());
  }
}
