package org.x402;

import org.x402.util.Json;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.MissingNode;
import com.fasterxml.jackson.databind.node.NullNode;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JsonValuesTest {

    private static JsonNode json(String text) throws IOException {
        return Json.readTree(text);
    }

    @Test
    void comparesNumbersByValueAcrossRepresentations() throws IOException {
        assertTrue(JsonValues.equal(Json.toTree(2), Json.toTree(2L)));
        assertTrue(JsonValues.equal(Json.toTree(2), json("2.0")));
        assertTrue(JsonValues.equal(json("{\"a\":[1,2]}"), Json.toTree(Map.of("a", List.of(1L, 2.0)))));
        assertFalse(JsonValues.equal(json("1"), json("2")));
        assertFalse(JsonValues.equal(json("1"), json("\"1\"")));
    }

    @Test
    void doesNotTreatNonFiniteDoublesAsNumbersEqualToOthers() {
        assertFalse(JsonValues.equal(Json.toTree(Double.NaN), Json.toTree(0)));
        assertTrue(JsonValues.equal(Json.toTree(Double.POSITIVE_INFINITY), Json.toTree(Double.POSITIVE_INFINITY)));
    }

    @Test
    void treatsJavaNullJsonNullAndMissingAsEqualOnlyToEachOther() throws IOException {
        assertTrue(JsonValues.equal(null, NullNode.getInstance()));
        assertTrue(JsonValues.equal(MissingNode.getInstance(), null));
        assertFalse(JsonValues.equal(null, json("0")));
        assertFalse(JsonValues.equal(json("\"\""), NullNode.getInstance()));
    }

    @Test
    void comparesObjectsIgnoringKeyOrderButArraysInOrder() throws IOException {
        assertTrue(JsonValues.equal(json("{\"a\":1,\"b\":2}"), json("{\"b\":2,\"a\":1}")));
        assertFalse(JsonValues.equal(json("{\"a\":1}"), json("{\"a\":1,\"b\":2}")));
        assertFalse(JsonValues.equal(json("[1,2]"), json("[2,1]")));
    }

    @Test
    void subsetAllowsAdditionalFieldsAtAnyDepth() throws IOException {
        assertTrue(JsonValues.containsSubset(
                json("{\"name\":\"USDC\",\"nested\":{\"a\":1}}"),
                json("{\"name\":\"USDC\",\"version\":\"2\",\"nested\":{\"a\":1,\"b\":2}}")));
    }

    @Test
    void subsetRequiresEveryExpectedFieldWithEqualValue() throws IOException {
        assertFalse(JsonValues.containsSubset(json("{\"name\":\"USDC\"}"), json("{}")));
        assertFalse(JsonValues.containsSubset(json("{\"name\":\"USDC\"}"), json("{\"name\":\"usdc\"}")));
        assertFalse(JsonValues.containsSubset(json("{\"nested\":{\"a\":1}}"), json("{\"nested\":\"a\"}")));
        assertFalse(JsonValues.containsSubset(json("{\"a\":1}"), json("[1]")));
        assertFalse(JsonValues.containsSubset(json("{\"a\":1}"), null));
    }

    @Test
    void subsetComparesArraysExactly() throws IOException {
        assertTrue(JsonValues.containsSubset(json("{\"l\":[1,2]}"), json("{\"l\":[1,2]}")));
        assertFalse(JsonValues.containsSubset(json("{\"l\":[1,2]}"), json("{\"l\":[1,2,3]}")));
        assertFalse(JsonValues.containsSubset(json("{\"l\":[{\"a\":1}]}"), json("{\"l\":[{\"a\":1,\"b\":2}]}")));
    }

    @Test
    void subsetLetsNullExpectedFieldsBeAbsentButNotDifferent() throws IOException {
        JsonNode expected = json("{\"feePayer\":null}");

        assertTrue(JsonValues.containsSubset(expected, json("{}")));
        assertTrue(JsonValues.containsSubset(expected, json("{\"feePayer\":null}")));
        assertFalse(JsonValues.containsSubset(expected, json("{\"feePayer\":\"0x1\"}")));
    }

    @Test
    void javaNullMapValuesAreKeptOnTheWire() throws IOException {
        Map<String, Object> declared = new HashMap<>();
        declared.put("feePayer", null);

        JsonNode tree = Json.toTree(declared);
        assertTrue(tree.has("feePayer"));
        assertTrue(JsonValues.containsSubset(tree, json("{}")));
        assertFalse(JsonValues.containsSubset(tree, json("{\"feePayer\":\"0x1\"}")));
    }

    @Test
    void subsetOfScalarsIsEquality() throws IOException {
        assertTrue(JsonValues.containsSubset(json("\"a\""), json("\"a\"")));
        assertFalse(JsonValues.containsSubset(json("\"a\""), json("\"b\"")));
        assertTrue(JsonValues.containsSubset(null, null));
    }
}
