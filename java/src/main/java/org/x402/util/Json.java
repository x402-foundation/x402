package org.x402.util;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;

import java.io.IOException;

/**
 * JSON serialization shared by the SDK.
 *
 * <p>Unknown properties are ignored on read. On write, {@code null} properties are omitted, matching the
 * {@code omitempty} behavior of the reference SDKs, while map entries are written as-is so echoed
 * {@code extra} and {@code extensions} objects stay verbatim. The underlying mapper is not exposed so it
 * cannot be reconfigured by callers.
 */
public final class Json {

    private static final ObjectMapper MAPPER = JsonMapper.builder()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .defaultPropertyInclusion(
                    JsonInclude.Value.construct(JsonInclude.Include.NON_NULL, JsonInclude.Include.ALWAYS))
            .build();

    private Json() {
    }

    /**
     * Serializes a value to compact JSON.
     *
     * @param value the value to serialize
     * @return the JSON text
     * @throws IllegalArgumentException if the value cannot be serialized
     */
    public static String write(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Cannot serialize " + value.getClass().getName(), e);
        }
    }

    /**
     * Parses JSON text into the given type.
     *
     * @param json the JSON text
     * @param type the target type
     * @param <T> the target type
     * @return the parsed value
     * @throws IOException if the text is not valid JSON for {@code type}
     */
    public static <T> T read(String json, Class<T> type) throws IOException {
        return MAPPER.readValue(json, type);
    }

    /**
     * Parses JSON bytes into the given type.
     *
     * @param json the UTF-8 encoded JSON
     * @param type the target type
     * @param <T> the target type
     * @return the parsed value
     * @throws IOException if the bytes are not valid JSON for {@code type}
     */
    public static <T> T read(byte[] json, Class<T> type) throws IOException {
        return MAPPER.readValue(json, type);
    }

    /**
     * Parses JSON text into a tree.
     *
     * @param json the JSON text
     * @return the root node
     * @throws IOException if the text is not valid JSON
     */
    public static JsonNode readTree(String json) throws IOException {
        return MAPPER.readTree(json);
    }

    /**
     * Converts a value into a JSON tree using the SDK's serialization rules.
     *
     * @param value the value to convert
     * @return the tree representation
     */
    public static JsonNode toTree(Object value) {
        return MAPPER.valueToTree(value);
    }

    /**
     * Converts a value, typically a {@code Map} parsed from JSON, into another type.
     *
     * @param value the source value
     * @param type the target type
     * @param <T> the target type
     * @return the converted value
     * @throws IllegalArgumentException if the value does not match {@code type}
     */
    public static <T> T convert(Object value, Class<T> type) {
        return MAPPER.convertValue(value, type);
    }
}
