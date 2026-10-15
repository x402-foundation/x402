package org.x402.e2e.client.networks;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.x402.core.json.X402Json;

/**
 * Network identity from the e2e mechanisms catalog ({@code e2e/config/mechanisms_<id>.json}), as
 * the Go client's {@code catalog_network.go} reads it.
 */
public final class CatalogNetworks {

  private CatalogNetworks() {}

  /**
   * The CAIP-2 network of a catalog network: {@code <ID>_NETWORK}, else the catalog's {@code
   * testnet.caip2}.
   *
   * @param networkId the catalog network id, e.g. {@code cardano}
   * @return the CAIP-2 id, e.g. {@code cardano:preprod}
   */
  public static String resolveCaip2(String networkId) {
    String fromEnv = System.getenv(networkId.toUpperCase(java.util.Locale.ROOT) + "_NETWORK");
    if (fromEnv != null && !fromEnv.isBlank()) {
      return fromEnv.trim();
    }
    return catalogTestnetCaip2(networkId);
  }

  /**
   * The client registration pattern of a CAIP-2 id: {@code cardano:preprod} → {@code cardano:*}.
   *
   * @param caip2 the CAIP-2 id
   * @return the namespace wildcard
   */
  public static String pattern(String caip2) {
    return namespace(caip2) + ":*";
  }

  /**
   * The CAIP-2 namespace: {@code cardano:preprod} → {@code cardano}.
   *
   * @param caip2 the CAIP-2 id
   * @return the namespace
   */
  public static String namespace(String caip2) {
    int colon = caip2.indexOf(':');
    if (colon <= 0) {
      throw new IllegalStateException("invalid CAIP-2 network: " + caip2);
    }
    return caip2.substring(0, colon);
  }

  /** Reads testnet.caip2 from {@code E2E_MECHANISMS_CATALOG}, else {@code config/} walking up. */
  private static String catalogTestnetCaip2(String networkId) {
    List<Path> candidates = new ArrayList<>();
    String injected = System.getenv("E2E_MECHANISMS_CATALOG");
    if (injected != null && !injected.isBlank()) {
      candidates.add(Path.of(injected.trim()));
    }
    for (Path dir = Path.of("").toAbsolutePath(); dir != null; dir = dir.getParent()) {
      candidates.add(dir.resolve("config"));
    }
    for (Path catalogDir : candidates) {
      Path file = catalogDir.resolve("mechanisms_" + networkId + ".json");
      if (!Files.isRegularFile(file)) {
        continue;
      }
      JsonNode root;
      try {
        root = X402Json.mapper().readTree(file.toFile());
      } catch (IOException e) {
        throw new IllegalStateException("cannot read " + file, e);
      }
      String caip2 = root.path("testnet").path("caip2").asText("");
      if (caip2.isEmpty()) {
        throw new IllegalStateException(file + ": missing testnet.caip2");
      }
      return caip2;
    }
    throw new IllegalStateException("could not locate mechanisms_" + networkId + ".json");
  }
}
