package org.x402.core.types;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Defensive, order-preserving, null-tolerant copies for the wire records. */
final class Collections2 {

  private Collections2() {}

  /**
   * Copies a JSON object map, keeping insertion order and {@code null} values.
   *
   * @param map the source, may be {@code null}
   * @return an unmodifiable copy, or {@code null} for {@code null}
   */
  static Map<String, Object> copyMap(Map<String, ?> map) {
    return map == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(map));
  }

  /**
   * Copies a JSON object map, defaulting {@code null} to an empty map.
   *
   * @param map the source, may be {@code null}
   * @return an unmodifiable copy, never {@code null}
   */
  static Map<String, Object> copyMapOrEmpty(Map<String, ?> map) {
    return map == null ? Map.of() : copyMap(map);
  }

  /**
   * Copies a list.
   *
   * @param list the source, may be {@code null}
   * @param <T> element type
   * @return an unmodifiable copy, or {@code null} for {@code null}
   */
  static <T> List<T> copyList(List<T> list) {
    return list == null ? null : List.copyOf(list);
  }
}
