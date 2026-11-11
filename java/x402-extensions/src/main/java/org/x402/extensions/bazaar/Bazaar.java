package org.x402.extensions.bazaar;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Builds {@code bazaar} route declarations. The returned
 * maps keep a fixed key order, so the serialized JSON is stable.
 */
public final class Bazaar {

  /** The extension key. */
  public static final String KEY = "bazaar";

  private static final String SCHEMA_URI = "https://json-schema.org/draft/2020-12/schema";
  private static final String TYPE = "type";
  private static final String OBJECT = "object";
  private static final String STRING = "string";
  private static final String PROPERTIES = "properties";
  private static final String INPUT = "input";
  private static final String OUTPUT = "output";
  private static final String EXAMPLE = "example";
  private static final String METHOD = "method";
  private static final String PATH_PARAMS = "pathParams";

  private Bazaar() {}

  /**
   * Declares discovery for an HTTP route.
   *
   * @param config the configuration
   * @return {@code {"bazaar": declaration}}, to be put into the route's {@code extensions}
   */
  public static Map<String, Object> declareDiscoveryExtension(HttpDiscoveryConfig config) {
    boolean body = config.bodyType() != null;
    Map<String, Object> input = config.input() == null ? Map.of() : config.input();
    Map<String, Object> inputSchema =
        config.inputSchema() == null ? map(PROPERTIES, Map.of()) : config.inputSchema();

    Map<String, Object> infoInput = map(TYPE, "http");
    putIfSet(infoInput, METHOD, config.method());
    Map<String, Object> inputProps = new LinkedHashMap<>();
    inputProps.put(TYPE, map(TYPE, STRING, "const", "http"));
    List<String> required;
    if (body) {
      infoInput.put("bodyType", config.bodyType());
      infoInput.put("body", input);
      putIfSet(infoInput, PATH_PARAMS, config.pathParams());
      inputProps.put(METHOD, map(TYPE, STRING, "enum", List.of("POST", "PUT", "PATCH")));
      inputProps.put("bodyType", map(TYPE, STRING, "enum", List.of("json", "form-data", "text")));
      inputProps.put("body", inputSchema);
      required = List.of(TYPE, METHOD, "bodyType", "body");
    } else {
      infoInput.put("queryParams", input);
      putIfSet(infoInput, PATH_PARAMS, config.pathParams());
      inputProps.put(METHOD, map(TYPE, STRING, "enum", List.of("GET", "HEAD", "DELETE")));
      Map<String, Object> query = map(TYPE, OBJECT);
      query.putAll(inputSchema);
      inputProps.put("queryParams", query);
      required = List.of(TYPE, METHOD);
    }
    if (config.pathParamsSchema() != null) {
      Map<String, Object> pathSchema = map(TYPE, OBJECT);
      pathSchema.putAll(config.pathParamsSchema());
      inputProps.put(PATH_PARAMS, pathSchema);
    }
    Map<String, Object> inputDef = map(TYPE, OBJECT);
    inputDef.put(PROPERTIES, inputProps);
    inputDef.put("required", required);
    inputDef.put("additionalProperties", false);
    return wrap(infoInput, inputDef, config.output());
  }

  /**
   * Declares discovery for an MCP tool.
   *
   * @param config the configuration
   * @return {@code {"bazaar": declaration}}
   */
  public static Map<String, Object> declareDiscoveryExtension(McpDiscoveryConfig config) {
    Map<String, Object> infoInput = map(TYPE, "mcp");
    infoInput.put("toolName", config.toolName());
    putIfSet(infoInput, "description", config.description());
    putIfSet(infoInput, "transport", config.transport());
    infoInput.put("inputSchema", config.inputSchema());
    putIfSet(infoInput, EXAMPLE, config.example());

    Map<String, Object> props = new LinkedHashMap<>();
    props.put(TYPE, map(TYPE, STRING, "const", "mcp"));
    props.put("toolName", map(TYPE, STRING));
    if (config.description() != null) {
      props.put("description", map(TYPE, STRING));
    }
    if (config.transport() != null) {
      Map<String, Object> transport = map(TYPE, STRING);
      if ("streamable-http".equals(config.transport()) || "sse".equals(config.transport())) {
        transport.put("enum", List.of(config.transport()));
      }
      props.put("transport", transport);
    }
    props.put("inputSchema", map(TYPE, OBJECT));
    if (config.example() != null) {
      props.put(EXAMPLE, map(TYPE, OBJECT));
    }
    Map<String, Object> inputDef = map(TYPE, OBJECT);
    inputDef.put(PROPERTIES, props);
    inputDef.put("required", List.of(TYPE, "toolName", "inputSchema"));
    inputDef.put("additionalProperties", false);
    return wrap(infoInput, inputDef, config.output());
  }

  private static Map<String, Object> wrap(
      Map<String, Object> infoInput, Map<String, Object> inputDef, DiscoveryOutput output) {
    Map<String, Object> info = map(INPUT, infoInput);
    Map<String, Object> schemaProps = map(INPUT, inputDef);
    if (output != null && truthy(output.example())) {
      info.put(OUTPUT, map(TYPE, "json", EXAMPLE, output.example()));
      Map<String, Object> example = map(TYPE, OBJECT);
      if (output.schema() != null) {
        example.putAll(output.schema());
      }
      Map<String, Object> outputProps = map(TYPE, map(TYPE, STRING));
      outputProps.put(EXAMPLE, example);
      Map<String, Object> outputDef = map(TYPE, OBJECT);
      outputDef.put(PROPERTIES, outputProps);
      outputDef.put("required", List.of(TYPE));
      schemaProps.put(OUTPUT, outputDef);
    }
    Map<String, Object> schema = map("$schema", SCHEMA_URI);
    schema.put(TYPE, OBJECT);
    schema.put(PROPERTIES, schemaProps);
    schema.put("required", List.of(INPUT));
    Map<String, Object> declaration = map("info", info);
    declaration.put("schema", schema);
    return map(KEY, declaration);
  }

  /** JS truthiness of an example value. */
  private static boolean truthy(Object value) {
    if (value == null || Boolean.FALSE.equals(value)) {
      return false;
    }
    if (value instanceof CharSequence text) {
      return text.length() > 0;
    }
    if (value instanceof Number number) {
      double d = number.doubleValue();
      return d != 0 && !Double.isNaN(d);
    }
    return true;
  }

  private static void putIfSet(Map<String, Object> target, String key, Object value) {
    if (value != null) {
      target.put(key, value);
    }
  }

  private static Map<String, Object> map(String key, Object value) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put(key, value);
    return out;
  }

  private static Map<String, Object> map(String k1, Object v1, String k2, Object v2) {
    Map<String, Object> out = map(k1, v1);
    out.put(k2, v2);
    return out;
  }
}
