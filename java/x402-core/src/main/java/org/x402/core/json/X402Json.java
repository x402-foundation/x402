package org.x402.core.json;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.io.UncheckedIOException;

/**
 * The one JSON configuration for x402 wire data. Output is compact and keeps declaration order
 * (headers are reproducible byte for byte); unknown fields are ignored on input.
 */
public final class X402Json {

  private static final ObjectMapper MAPPER =
      JsonMapper.builder()
          .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
          .disable(SerializationFeature.FAIL_ON_EMPTY_BEANS)
          .disable(SerializationFeature.INDENT_OUTPUT)
          .build();

  private X402Json() {}

  /**
   * Returns the shared mapper. Do not reconfigure it.
   *
   * @return the mapper
   */
  public static ObjectMapper mapper() {
    return MAPPER;
  }

  /**
   * Serializes a value compactly.
   *
   * @param value the value
   * @return the JSON text
   */
  public static String write(Object value) {
    try {
      return MAPPER.writeValueAsString(value);
    } catch (JsonProcessingException e) {
      throw new UncheckedIOException(e);
    }
  }

  /**
   * Parses JSON into a type.
   *
   * @param json the JSON text
   * @param type the target type
   * @param <T> the target type
   * @return the value
   * @throws IllegalArgumentException when the JSON is malformed or does not fit the type
   */
  public static <T> T read(String json, Class<T> type) {
    try {
      return MAPPER.readValue(json, type);
    } catch (JsonProcessingException e) {
      throw new IllegalArgumentException("Invalid JSON for " + type.getSimpleName(), e);
    }
  }

  /**
   * Converts between representations, e.g. a {@link JsonNode} or map into a record.
   *
   * @param value the source value
   * @param type the target type
   * @param <T> the target type
   * @return the converted value
   */
  public static <T> T convert(Object value, Class<T> type) {
    return MAPPER.convertValue(value, type);
  }
}
