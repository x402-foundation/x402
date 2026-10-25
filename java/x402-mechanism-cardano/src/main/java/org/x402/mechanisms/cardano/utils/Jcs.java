package org.x402.mechanisms.cardano.utils;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.x402.core.json.X402Json;

/**
 * RFC 8785 JSON canonicalization, as the Masumi digests require: members
 * sorted by UTF-16 code units, numbers in ECMAScript {@code Number#toString} form (every number
 * passes through a double, as in JavaScript), JSON string escaping, unpaired surrogates refused.
 * Also the {@code deepEqual} of {@code @x402/core}, which compares canonical JSON.
 */
public final class Jcs {

  private Jcs() {}

  /**
   * Canonicalizes a JSON value: {@code null}, {@link Boolean}, {@link Number}, {@link
   * CharSequence}, {@link Map}, {@link Collection}, {@link JsonNode}, or a record/bean that
   * Jackson can turn into JSON.
   *
   * @param value the value
   * @return the canonical text
   * @throws IllegalArgumentException for non-finite numbers, unpaired surrogates and values JSON
   *     cannot represent
   */
  public static String canonicalize(Object value) {
    StringBuilder out = new StringBuilder();
    write(value, out);
    return out.toString();
  }

  /**
   * Deep equality of two JSON values: equal canonical JSON (key order ignored).
   *
   * @param a the first value
   * @param b the second value
   * @return whether both serialize to the same canonical JSON
   */
  public static boolean deepEqual(Object a, Object b) {
    try {
      return canonicalize(toJson(a)).equals(canonicalize(toJson(b)));
    } catch (RuntimeException e) {
      return Objects.equals(a, b);
    }
  }

  /**
   * Converts records and beans to a JSON tree; JSON-shaped values pass through.
   *
   * @param value the value
   * @return a JSON-shaped value
   */
  static Object toJson(Object value) {
    if (value == null
        || value instanceof Map
        || value instanceof Collection
        || value instanceof CharSequence
        || value instanceof Number
        || value instanceof Boolean
        || value instanceof JsonNode) {
      return value;
    }
    if (value instanceof Record) {
      return X402Json.mapper().valueToTree(value);
    }
    return value;
  }

  private static void write(Object value, StringBuilder out) {
    if (value == null) {
      out.append("null");
    } else if (value instanceof Boolean b) {
      out.append(b ? "true" : "false");
    } else if (value instanceof Number n) {
      out.append(number(n));
    } else if (value instanceof CharSequence s) {
      string(s.toString(), out);
    } else if (value instanceof Map<?, ?> map) {
      writeObject(map, out);
    } else if (value instanceof Collection<?> list) {
      out.append('[');
      boolean first = true;
      for (Object item : list) {
        if (!first) {
          out.append(',');
        }
        first = false;
        write(item, out);
      }
      out.append(']');
    } else if (value instanceof JsonNode node) {
      write(fromNode(node), out);
    } else if (value instanceof Record) {
      write(X402Json.mapper().valueToTree(value), out);
    } else {
      throw new IllegalArgumentException(
          "JCS cannot serialize a value of type " + value.getClass().getSimpleName());
    }
  }

  private static void writeObject(Map<?, ?> map, StringBuilder out) {
    List<String> keys = new ArrayList<>();
    for (Object key : map.keySet()) {
      if (!(key instanceof String s)) {
        throw new IllegalArgumentException("JCS object keys must be strings");
      }
      keys.add(s);
    }
    keys.sort(null);
    out.append('{');
    boolean first = true;
    for (String key : keys) {
      if (!first) {
        out.append(',');
      }
      first = false;
      string(key, out);
      out.append(':');
      write(map.get(key), out);
    }
    out.append('}');
  }

  private static Object fromNode(JsonNode node) {
    if (node.isNull() || node.isMissingNode()) {
      return null;
    }
    if (node.isBoolean()) {
      return node.booleanValue();
    }
    if (node.isNumber()) {
      return node.numberValue();
    }
    if (node.isTextual()) {
      return node.textValue();
    }
    if (node.isArray()) {
      List<Object> items = new ArrayList<>();
      node.forEach(n -> items.add(fromNode(n)));
      return items;
    }
    Map<String, Object> map = new java.util.LinkedHashMap<>();
    node.fields().forEachRemaining(e -> map.put(e.getKey(), fromNode(e.getValue())));
    return map;
  }

  private static void string(String value, StringBuilder out) {
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (Character.isHighSurrogate(c)) {
        if (i + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(i + 1))) {
          throw new IllegalArgumentException(
              "JCS cannot serialize a string containing an unpaired surrogate");
        }
        i++;
      } else if (Character.isLowSurrogate(c)) {
        throw new IllegalArgumentException(
            "JCS cannot serialize a string containing an unpaired surrogate");
      }
    }
    out.append('"');
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '"':
          out.append("\\\"");
          break;
        case '\\':
          out.append("\\\\");
          break;
        case '\b':
          out.append("\\b");
          break;
        case '\f':
          out.append("\\f");
          break;
        case '\n':
          out.append("\\n");
          break;
        case '\r':
          out.append("\\r");
          break;
        case '\t':
          out.append("\\t");
          break;
        default:
          if (c < 0x20) {
            out.append(String.format("\\u%04x", (int) c));
          } else {
            out.append(c);
          }
      }
    }
    out.append('"');
  }

  /**
   * ECMAScript {@code Number#toString} of a number (converted to a double first, as JavaScript
   * would hold it).
   *
   * @param n the number
   * @return the text
   * @throws IllegalArgumentException for NaN and infinities
   */
  public static String number(Number n) {
    double d =
        n instanceof BigDecimal bd ? bd.doubleValue() : n instanceof BigInteger bi ? bi.doubleValue() : n.doubleValue();
    if (!Double.isFinite(d)) {
      throw new IllegalArgumentException("JCS cannot serialize the non-finite number " + format(d));
    }
    return format(d);
  }

  private static String format(double d) {
    if (Double.isNaN(d)) {
      return "NaN";
    }
    if (Double.isInfinite(d)) {
      return d > 0 ? "Infinity" : "-Infinity";
    }
    if (d == 0) {
      return "0";
    }
    if (d < 0) {
      return "-" + format(-d);
    }
    BigDecimal exact = new BigDecimal(d);
    BigDecimal shortest = exact;
    // ECMAScript Number::toString: the fewest digits that read back as d; of the candidates with
    // that many digits, the one closest to d, and on an exact tie the one with an even last digit.
    // Rounding down and up both matter: at a power of two the interval below d is half as wide,
    // so the nearest k-digit value may miss while the neighbour on the other side hits.
    for (int precision = 1; precision <= 17; precision++) {
      BigDecimal best = null;
      for (RoundingMode mode : new RoundingMode[] {RoundingMode.DOWN, RoundingMode.UP}) {
        BigDecimal candidate = exact.round(new MathContext(precision, mode));
        if (Double.parseDouble(candidate.toString()) != d) {
          continue;
        }
        if (best == null) {
          best = candidate;
          continue;
        }
        int closer = candidate.subtract(exact).abs().compareTo(best.subtract(exact).abs());
        if (closer < 0 || (closer == 0 && best.unscaledValue().testBit(0))) {
          best = candidate;
        }
      }
      if (best != null) {
        shortest = best;
        break;
      }
    }
    shortest = shortest.stripTrailingZeros();
    String digits = shortest.unscaledValue().toString();
    int k = digits.length();
    int n = k - shortest.scale();
    StringBuilder out = new StringBuilder();
    if (k <= n && n <= 21) {
      out.append(digits);
      for (int i = 0; i < n - k; i++) {
        out.append('0');
      }
    } else if (0 < n && n <= 21) {
      out.append(digits, 0, n).append('.').append(digits, n, k);
    } else if (-6 < n && n <= 0) {
      out.append("0.");
      for (int i = 0; i < -n; i++) {
        out.append('0');
      }
      out.append(digits);
    } else {
      int e = n - 1;
      out.append(digits.charAt(0));
      if (k > 1) {
        out.append('.').append(digits, 1, k);
      }
      out.append('e').append(e < 0 ? '-' : '+').append(Math.abs(e));
    }
    return out.toString();
  }
}
