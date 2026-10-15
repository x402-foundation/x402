package org.x402.core.utils;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.NullNode;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.x402.core.json.X402Json;

/**
 * Structural comparison of JSON-like values ({@code Map}, {@code List}, strings, numbers,
 * booleans, {@code null}, or anything Jackson can convert).
 * Numbers compare by value, so {@code 1} equals
 * {@code 1.0}.
 */
public final class JsonValues {

  /** Builder-code {@code s}: an array the client may extend. */
  public static final Map<String, Set<String>> ADDITIVE_ARRAY_INFO_FIELDS =
      Map.of("builder-code", Set.of("s"));

  /** Fields only the server may declare. */
  public static final Map<String, Set<String>> SERVER_OWNED_INFO_FIELDS =
      Map.of("builder-code", Set.of("a"));

  /** Combined-length caps of additive fields. */
  public static final Map<String, Map<String, Integer>> ADDITIVE_ARRAY_MAX_LENGTHS =
      Map.of("builder-code", Map.of("s", 10));

  private static final Comparator<JsonNode> BY_VALUE = (a, b) -> {
    if (a.isNumber() && b.isNumber()) {
      return a.decimalValue().compareTo(b.decimalValue());
    }
    return a.equals(b) ? 0 : 1;
  };

  private JsonValues() {}

  /**
   * Converts a value to a JSON tree.
   *
   * @param value the value, may be {@code null}
   * @return the tree; {@code null} becomes a JSON null
   */
  public static JsonNode toNode(Object value) {
    if (value == null) {
      return NullNode.getInstance();
    }
    if (value instanceof JsonNode node) {
      return node;
    }
    JsonNode node = X402Json.mapper().valueToTree(value);
    return node == null ? NullNode.getInstance() : node;
  }

  /**
   * Structural equality ignoring object key order.
   *
   * @param a first value
   * @param b second value
   * @return whether they are deeply equal
   */
  public static boolean deepEqual(Object a, Object b) {
    return toNode(a).equals(BY_VALUE, toNode(b));
  }

  /**
   * Whether {@code actual} contains every field
   * of {@code expected}; objects may carry extra fields; everything else must be deeply equal.
   *
   * @param expected the required subset
   * @param actual the candidate
   * @return whether {@code actual} contains {@code expected}
   */
  public static boolean containsSubset(Object expected, Object actual) {
    return containsSubset(toNode(expected), toNode(actual), Set.of(), Map.of(), null);
  }

  /**
   * Like {@link #containsSubset(Object, Object)}, but the listed array fields may be extended.
   *
   * @param expected the required subset
   * @param actual the candidate
   * @param additiveFields field names whose arrays the candidate may extend
   * @param maxLengths combined-length caps per additive field
   * @return whether {@code actual} contains {@code expected}
   */
  public static boolean containsSubset(
      Object expected, Object actual, Set<String> additiveFields, Map<String, Integer> maxLengths) {
    return containsSubset(toNode(expected), toNode(actual), additiveFields, maxLengths, null);
  }

  private static boolean containsSubset(
      JsonNode expected,
      JsonNode actual,
      Set<String> additiveFields,
      Map<String, Integer> maxLengths,
      String fieldKey) {
    if (fieldKey != null && additiveFields.contains(fieldKey)
        && (expected.isArray() || actual.isArray())) {
      List<JsonNode> exp = comparableArray(expected);
      List<JsonNode> act = comparableArray(actual);
      if (exp == null || act == null) {
        return false;
      }
      Integer max = maxLengths.get(fieldKey);
      if (max != null && act.size() > max) {
        return false;
      }
      for (JsonNode e : exp) {
        if (act.stream().noneMatch(x -> e.equals(BY_VALUE, x))) {
          return false;
        }
      }
      return true;
    }
    if (!expected.isObject()) {
      return expected.equals(BY_VALUE, actual);
    }
    if (!actual.isObject()) {
      return false;
    }
    for (Map.Entry<String, JsonNode> e : expected.properties()) {
      JsonNode candidate = actual.get(e.getKey());
      if (candidate == null) {
        return false;
      }
      if (!containsSubset(e.getValue(), candidate, additiveFields, maxLengths, e.getKey())) {
        return false;
      }
    }
    return true;
  }

  private static List<JsonNode> comparableArray(JsonNode node) {
    if (node.isArray()) {
      List<JsonNode> out = new ArrayList<>();
      node.forEach(out::add);
      return out;
    }
    if (node.isNull() || node.isObject() || node.isMissingNode()) {
      return null;
    }
    return List.of(node);
  }

  /**
   * Returns a copy of a map without the given keys.
   *
   * @param value the map, may be {@code null}
   * @param fields keys to drop
   * @return the copy, or the value itself when nothing applies
   */
  public static Map<String, Object> omit(Map<String, Object> value, Collection<String> fields) {
    if (value == null || fields == null || fields.isEmpty()) {
      return value;
    }
    Map<String, Object> copy = new LinkedHashMap<>(value);
    fields.forEach(copy::remove);
    return copy;
  }

  /**
   * Converts a JSON tree to plain Java values ({@code Map}, {@code List}, …).
   *
   * @param node the tree
   * @return the plain value
   */
  public static Object toPlain(JsonNode node) {
    return X402Json.mapper().convertValue(node, Object.class);
  }

  /**
   * Whether a value is a JSON object (a map).
   *
   * @param value the value
   * @return {@code true} for maps
   */
  public static boolean isRecord(Object value) {
    return value instanceof Map;
  }
}
