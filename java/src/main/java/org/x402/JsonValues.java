package org.x402;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.Comparator;
import java.util.Map;

/**
 * Structural comparison of JSON values.
 *
 * <p>Values are compared after conversion to JSON trees, so a {@code Map} built in Java and the same object
 * parsed from a header compare equal. Numbers compare by value: {@code 2}, {@code 2L} and {@code 2.0} are
 * equal.
 */
final class JsonValues {

    private static final Comparator<JsonNode> NUMERIC_AWARE = (a, b) -> sameScalar(a, b) ? 0 : 1;

    private JsonValues() {
    }

    /**
     * Returns whether two JSON values are equal. Objects compare key by key regardless of order, arrays
     * element by element in order, and numbers by value.
     *
     * @param a a value, or {@code null} for JSON null
     * @param b a value, or {@code null} for JSON null
     * @return {@code true} if both values are equal
     */
    static boolean equal(JsonNode a, JsonNode b) {
        if (isNull(a) || isNull(b)) {
            return isNull(a) && isNull(b);
        }
        return a.equals(NUMERIC_AWARE, b);
    }

    /**
     * Returns whether {@code actual} contains every field of {@code expected}.
     *
     * <p>Objects are compared recursively: {@code actual} may carry additional fields, and a field whose
     * expected value is JSON null may be absent. Arrays and scalars must be {@link #equal equal}.
     *
     * @param expected the required value, e.g. server-declared {@code extra}
     * @param actual the value to check, e.g. the client's echo
     * @return {@code true} if {@code actual} preserves {@code expected}
     */
    static boolean containsSubset(JsonNode expected, JsonNode actual) {
        if (expected == null || !expected.isObject()) {
            return equal(expected, actual);
        }
        if (actual == null || !actual.isObject()) {
            return false;
        }
        for (Map.Entry<String, JsonNode> field : expected.properties()) {
            JsonNode actualValue = actual.get(field.getKey());
            if (actualValue == null) {
                if (field.getValue().isNull()) {
                    continue;
                }
                return false;
            }
            if (!containsSubset(field.getValue(), actualValue)) {
                return false;
            }
        }
        return true;
    }

    private static boolean isNull(JsonNode node) {
        return node == null || node.isNull() || node.isMissingNode();
    }

    private static boolean sameScalar(JsonNode a, JsonNode b) {
        if (a.equals(b)) {
            return true;
        }
        if (!a.isNumber() || !b.isNumber() || !isFinite(a) || !isFinite(b)) {
            return false;
        }
        return a.decimalValue().compareTo(b.decimalValue()) == 0;
    }

    private static boolean isFinite(JsonNode number) {
        return !(number.isDouble() || number.isFloat()) || Double.isFinite(number.doubleValue());
    }
}
