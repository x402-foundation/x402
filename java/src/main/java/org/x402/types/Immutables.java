package org.x402.types;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Defensive copies for record components. Preserves order and allows {@code null} JSON values. */
final class Immutables {

    private Immutables() {
    }

    static <K, V> Map<K, V> map(Map<K, V> source) {
        return source == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(source));
    }

    static <T> List<T> list(List<T> source) {
        return source == null ? null : Collections.unmodifiableList(new ArrayList<>(source));
    }
}
