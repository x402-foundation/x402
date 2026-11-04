package org.x402.e2e.server;

import org.x402.AssetAmount;
import org.x402.Price;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Mechanisms catalog loader for the Java e2e resource servers, mirroring {@code e2e/servers/go/catalog.go}.
 *
 * <p>The catalog is {@code e2e/config/mechanisms_global.json} plus one {@code mechanisms_<id>.json} per network.
 * Routes, prices and payees all come from there, so no server entrypoint names a path or a price. A route is
 * served when its {@code sdks} list {@value #SDK}, the harness has not excluded its scheme or network, it matches
 * {@code E2E_BATCH_SERVER_ROLE}, and its {@code requiresEnv} / {@code requiresEnvAbsent} conditions hold.
 * {@link #resolvedRoutes()} also requires {@code SERVER_<ID>_ADDRESS}.
 */
public final class Catalog {

    /** The id a route lists in {@code sdks} when the Java SDK serves it. */
    public static final String SDK = "java";

    private static final String GLOBAL_FILE = "mechanisms_global.json";
    private static final Pattern NETWORK_FILE = Pattern.compile("^mechanisms_(.+)\\.json$");
    private static final String MANAGED_BATCH_ROLE = "managed-batch";
    private static final String AUTHORIZATION_FLOW = "authorization";
    private static final String ASSET_TRANSFER_METHOD = "assetTransferMethod";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> OBJECT = new TypeReference<>() { };

    private final Map<String, String> env;
    private final Map<String, JsonNode> networks;
    private final List<CatalogRoute> routes;

    private Catalog(Map<String, String> env, Map<String, JsonNode> networks, List<CatalogRoute> routes) {
        this.env = env;
        this.networks = networks;
        this.routes = List.copyOf(routes);
    }

    /**
     * Loads the catalog from {@code E2E_MECHANISMS_CATALOG}, or from the first {@code config/} directory found
     * walking up from the working directory, keeping the routes this process serves.
     *
     * @param env the environment
     * @return the catalog
     * @throws IOException if the catalog cannot be found or read, or two files declare the same path
     */
    public static Catalog load(Map<String, String> env) throws IOException {
        Path dir = findCatalogDir(env);
        Map<String, JsonNode> networks = new TreeMap<>();
        List<CatalogRoute> routes = new ArrayList<>();
        Set<String> paths = new HashSet<>();
        for (Path file : networkFiles(dir)) {
            Matcher name = NETWORK_FILE.matcher(file.getFileName().toString());
            String networkId = name.matches() ? name.group(1) : "";
            JsonNode root = JSON.readTree(file.toFile());
            networks.put(networkId, root);
            for (Map.Entry<String, JsonNode> entry : root.path("routes").properties()) {
                String path = entry.getKey();
                if (!paths.add(path)) {
                    throw new IOException("Duplicate route path across mechanisms catalog files: " + path);
                }
                if (servedHere(entry.getValue(), networkId, env)) {
                    routes.add(route(path, networkId, entry.getValue()));
                }
            }
        }
        return new Catalog(env, networks, routes);
    }

    /**
     * Returns the routes this process serves, in catalog order, whether or not their payee is configured.
     *
     * @return the routes
     */
    public List<CatalogRoute> routes() {
        return routes;
    }

    /**
     * Returns the routes whose payee is configured, with network, price and {@code extra} resolved.
     *
     * @return the resolved routes, in catalog order
     * @throws IllegalStateException if a route declares an incomplete price
     */
    public List<ResolvedRoute> resolvedRoutes() {
        List<ResolvedRoute> resolved = new ArrayList<>();
        for (CatalogRoute route : routes) {
            String payTo = env.get(serverAddressEnvKey(route.networkId()));
            if (isBlank(payTo)) {
                continue;
            }
            String network = networkCaip2(route.networkId());
            Map<String, Object> extra = new LinkedHashMap<>(route.requirementsExtra());
            Price price = resolvePrice(route, network, extra);
            if (route.paymentFlow() != null && !AUTHORIZATION_FLOW.equals(route.paymentFlow())) {
                extra.put("paymentFlow", route.paymentFlow());
            }
            extra.putAll(route.schemeExtra());
            resolved.add(new ResolvedRoute(route.path(), route.networkId(), route.scheme(), network, payTo, price,
                    extra.isEmpty() ? null : extra));
        }
        return resolved;
    }

    /**
     * Returns a network's CAIP-2 id: {@code <ID>_NETWORK} when set, otherwise the catalog's testnet id.
     *
     * @param networkId the catalog network id
     * @return the CAIP-2 network
     * @throws IllegalArgumentException if the catalog has no such network
     */
    public String networkCaip2(String networkId) {
        String fromEnv = env.get(networkId.toUpperCase(Locale.ROOT) + "_NETWORK");
        if (!isBlank(fromEnv)) {
            return fromEnv;
        }
        return network(networkId).path("testnet").path("caip2").asText();
    }

    /**
     * Returns the env key naming a network's payee, {@code SERVER_<ID>_ADDRESS}.
     *
     * @param networkId the catalog network id
     * @return the env key
     */
    public static String serverAddressEnvKey(String networkId) {
        return "SERVER_" + networkId.toUpperCase(Locale.ROOT) + "_ADDRESS";
    }

    private static Path findCatalogDir(Map<String, String> env) throws IOException {
        String injected = env.get("E2E_MECHANISMS_CATALOG");
        if (!isBlank(injected)) {
            Path dir = Path.of(injected);
            if (!Files.isDirectory(dir)) {
                throw new IOException("E2E_MECHANISMS_CATALOG does not point at a directory: " + injected);
            }
            return dir;
        }
        for (Path dir = Path.of("").toAbsolutePath(); dir != null; dir = dir.getParent()) {
            if (Files.isRegularFile(dir.resolve("config").resolve(GLOBAL_FILE))) {
                return dir.resolve("config");
            }
        }
        throw new IOException("Could not locate e2e/config/" + GLOBAL_FILE);
    }

    private static List<Path> networkFiles(Path dir) throws IOException {
        try (Stream<Path> files = Files.list(dir)) {
            return files
                    .filter(file -> !file.getFileName().toString().equals(GLOBAL_FILE))
                    .filter(file -> NETWORK_FILE.matcher(file.getFileName().toString()).matches())
                    .sorted()
                    .collect(Collectors.toList());
        }
    }

    private static boolean servedHere(JsonNode definition, String networkId, Map<String, String> env) {
        String scheme = definition.path("scheme").asText();
        if (!values(definition.path("sdks")).contains(SDK)
                || listed(env, "E2E_EXCLUDE_SCHEMES").contains(scheme)
                || listed(env, "E2E_EXCLUDE_NETWORKS").contains(networkId)) {
            return false;
        }
        boolean managedBatch = "batch-settlement".equals(scheme)
                && definition.path("schemeOptions").path("facilitatorManaged").asBoolean();
        String role = env.getOrDefault("E2E_BATCH_SERVER_ROLE", "").strip().toLowerCase(Locale.ROOT);
        if (managedBatch != MANAGED_BATCH_ROLE.equals(role)) {
            return false;
        }
        String requiresEnv = text(definition, "requiresEnv");
        String requiresEnvAbsent = text(definition, "requiresEnvAbsent");
        return (requiresEnv == null || !isBlank(env.get(requiresEnv)))
                && (requiresEnvAbsent == null || isBlank(env.get(requiresEnvAbsent)));
    }

    private static CatalogRoute route(String path, String networkId, JsonNode definition) {
        return new CatalogRoute(
                path,
                networkId,
                definition.path("scheme").asText(),
                text(definition, ASSET_TRANSFER_METHOD),
                text(definition, "paymentFlow"),
                definition.path("price"),
                object(definition.path("requirementsExtra")),
                object(definition.path("schemeExtra")));
    }

    /**
     * Resolves a price as Go's {@code resolvePrice}: a {@code usd} price is converted by the scheme into the
     * network's default asset; otherwise {@code amount} and {@code asset}, each overridable from the env, become
     * an {@link AssetAmount} carrying the transfer method and any EIP-712 domain in its {@code extra}.
     */
    private Price resolvePrice(CatalogRoute route, String network, Map<String, Object> routeExtra) {
        JsonNode spec = route.price();
        String usd = text(spec, "usd");
        if (usd != null) {
            if (spec.path("declareAssetTransferMethod").asBoolean() && route.assetTransferMethod() != null) {
                routeExtra.put(ASSET_TRANSFER_METHOD, route.assetTransferMethod());
            }
            return Price.money(usd);
        }

        JsonNode mode = networkMode(route.networkId(), network);
        String amount = fromEnvOr(text(spec, "amountEnv"), text(spec, "amount"));
        String assetDefault = "permit2".equals(text(spec, "assetRef")) ? text(mode, "permit2Asset") : text(spec, "asset");
        String asset = fromEnvOr(text(spec, "assetEnv"), assetDefault);
        if (amount == null || asset == null) {
            throw new IllegalStateException("Route " + route.path() + ": price has no " + (amount == null ? "amount" : "asset"));
        }
        boolean assetOverridden = assetDefault != null && !asset.equals(assetDefault);

        Map<String, Object> extra = new LinkedHashMap<>();
        if (route.assetTransferMethod() != null) {
            extra.put(ASSET_TRANSFER_METHOD, route.assetTransferMethod());
        }
        String permit2AssetName = text(mode, "permit2AssetName");
        if (spec.path("permit2Domain").asBoolean() && permit2AssetName != null) {
            extra.put("name", permit2AssetName);
            extra.put("version", "2");
        }
        for (Map.Entry<String, JsonNode> entry : spec.path("extraEnv").properties()) {
            JsonNode extraEnv = entry.getValue();
            String value = env.get(extraEnv.path("env").asText());
            if (!isBlank(value) && (assetOverridden || !extraEnv.path("whenAssetOverridden").asBoolean())) {
                extra.put(entry.getKey(), value);
            }
        }
        return new AssetAmount(amount, asset, extra.isEmpty() ? null : extra);
    }

    private JsonNode networkMode(String networkId, String network) {
        JsonNode mainnet = network(networkId).path("mainnet");
        return network.equals(mainnet.path("caip2").asText()) ? mainnet : network(networkId).path("testnet");
    }

    private JsonNode network(String networkId) {
        JsonNode network = networks.get(networkId);
        if (network == null) {
            throw new IllegalArgumentException("Unknown network in catalog: " + networkId);
        }
        return network;
    }

    private String fromEnvOr(String envKey, String fallback) {
        String fromEnv = envKey == null ? null : env.get(envKey);
        return isBlank(fromEnv) ? fallback : fromEnv;
    }

    private static Set<String> listed(Map<String, String> env, String name) {
        return Arrays.stream(env.getOrDefault(name, "").split(","))
                .map(String::strip)
                .filter(part -> !part.isEmpty())
                .collect(Collectors.toSet());
    }

    private static List<String> values(JsonNode array) {
        List<String> values = new ArrayList<>();
        array.forEach(value -> values.add(value.asText()));
        return values;
    }

    private static Map<String, Object> object(JsonNode node) {
        return node.isObject() ? JSON.convertValue(node, OBJECT) : Map.of();
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() || value.asText().isEmpty() ? null : value.asText();
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
