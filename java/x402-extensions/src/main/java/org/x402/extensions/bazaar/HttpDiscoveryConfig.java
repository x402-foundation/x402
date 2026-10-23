package org.x402.extensions.bazaar;

import java.util.Map;
import java.util.Set;

/**
 * Configuration of an HTTP discovery declaration. Setting {@link #bodyType(String)} makes it a
 * body declaration (POST, PUT, PATCH); otherwise it is a query declaration (GET, HEAD, DELETE).
 * Unset {@code input} and {@code inputSchema} default to an empty example and an empty-properties
 * schema.
 */
public final class HttpDiscoveryConfig {

  private static final Set<String> BODY_TYPES = Set.of("json", "form-data", "text");

  private String method;
  private Map<String, Object> input;
  private Map<String, Object> inputSchema;
  private Map<String, Object> pathParams;
  private Map<String, Object> pathParamsSchema;
  private String bodyType;
  private DiscoveryOutput output;

  private HttpDiscoveryConfig() {}

  /**
   * An empty configuration, i.e. a query declaration with defaults.
   *
   * @return the configuration
   */
  public static HttpDiscoveryConfig create() {
    return new HttpDiscoveryConfig();
  }

  /**
   * Sets the HTTP method; optional, the server extension fills it in per request.
   *
   * @param value the method
   * @return this
   */
  public HttpDiscoveryConfig method(String value) {
    this.method = value;
    return this;
  }

  /**
   * Sets the example query parameters, or the example body for a body declaration.
   *
   * @param value the example, default empty
   * @return this
   */
  public HttpDiscoveryConfig input(Map<String, Object> value) {
    this.input = value;
    return this;
  }

  /**
   * Sets the JSON schema of the query parameters or the body.
   *
   * @param value the schema, default {@code {"properties": {}}}
   * @return this
   */
  public HttpDiscoveryConfig inputSchema(Map<String, Object> value) {
    this.inputSchema = value;
    return this;
  }

  /**
   * Sets concrete path parameter values.
   *
   * @param value the values
   * @return this
   */
  public HttpDiscoveryConfig pathParams(Map<String, Object> value) {
    this.pathParams = value;
    return this;
  }

  /**
   * Sets the JSON schema of the path parameters.
   *
   * @param value the schema
   * @return this
   */
  public HttpDiscoveryConfig pathParamsSchema(Map<String, Object> value) {
    this.pathParamsSchema = value;
    return this;
  }

  /**
   * Makes this a body declaration.
   *
   * @param value {@code json}, {@code form-data} or {@code text}
   * @return this
   * @throws IllegalArgumentException for any other value
   */
  public HttpDiscoveryConfig bodyType(String value) {
    if (value == null || !BODY_TYPES.contains(value)) {
      throw new IllegalArgumentException("bodyType must be one of " + BODY_TYPES + ": " + value);
    }
    this.bodyType = value;
    return this;
  }

  /**
   * Sets the output example and schema.
   *
   * @param value the output, may be {@code null}
   * @return this
   */
  public HttpDiscoveryConfig output(DiscoveryOutput value) {
    this.output = value;
    return this;
  }

  String method() {
    return method;
  }

  Map<String, Object> input() {
    return input;
  }

  Map<String, Object> inputSchema() {
    return inputSchema;
  }

  Map<String, Object> pathParams() {
    return pathParams;
  }

  Map<String, Object> pathParamsSchema() {
    return pathParamsSchema;
  }

  String bodyType() {
    return bodyType;
  }

  DiscoveryOutput output() {
    return output;
  }
}
