package org.x402.mechanisms.cardano.testing;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;

/**
 * Loads the fixtures under {@code src/test/resources/vectors}, exported from the TypeScript SDK
 * by {@code java/tools/ts-vectors}.
 */
public final class Vectors {

  private Vectors() {}

  /**
   * Reads one fixture document.
   *
   * @param name the file name, e.g. {@code cardano-facilitator.json}
   * @return the parsed document
   */
  public static JsonNode load(String name) {
    try (InputStream in = Vectors.class.getResourceAsStream("/vectors/" + name)) {
      if (in == null) {
        throw new IllegalStateException("missing vector file " + name);
      }
      return X402Json.mapper().readTree(in);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  /**
   * The facilitator fixtures.
   *
   * @return every fixture object
   */
  public static List<JsonNode> facilitatorFixtures() {
    List<JsonNode> result = new ArrayList<>();
    load("cardano-facilitator.json").get("fixtures").forEach(result::add);
    return result;
  }

  /**
   * One facilitator fixture by id.
   *
   * @param id the fixture id
   * @return the fixture
   */
  public static JsonNode fixture(String id) {
    return facilitatorFixtures().stream()
        .filter(f -> f.get("id").asText().equals(id))
        .findFirst()
        .orElseThrow(() -> new IllegalArgumentException("no fixture " + id));
  }

  /**
   * The epoch millisecond the fixtures were exported at.
   *
   * @return {@code now}
   */
  public static long now() {
    return load("cardano-facilitator.json").get("now").asLong();
  }

  /**
   * Converts a JSON node into requirements.
   *
   * @param node the node
   * @return the requirements
   */
  public static PaymentRequirements requirements(JsonNode node) {
    return X402Json.convert(node, PaymentRequirements.class);
  }

  /**
   * Converts a JSON node into a payload.
   *
   * @param node the node
   * @return the payload
   */
  public static PaymentPayload payload(JsonNode node) {
    return X402Json.convert(node, PaymentPayload.class);
  }

  /**
   * Converts a JSON node into a plain map.
   *
   * @param node the node
   * @return the map
   */
  public static Map<String, Object> map(JsonNode node) {
    return X402Json.mapper().convertValue(node, new TypeReference<Map<String, Object>>() {});
  }
}
