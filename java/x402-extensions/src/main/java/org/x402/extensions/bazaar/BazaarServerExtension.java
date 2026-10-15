package org.x402.extensions.bazaar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.x402.core.server.ResourceServerExtension;
import org.x402.http.HttpRequestContext;

/**
 * The {@code bazaar} resource-server extension. Per
 * request it narrows the declared method enum to the actual method and, for parameterized routes,
 * adds the {@code routeTemplate} catalog key and the concrete {@code pathParams}.
 */
public final class BazaarServerExtension implements ResourceServerExtension {

  private static final Pattern BRACKET = Pattern.compile("\\[([^\\]]+)\\]");
  private static final Pattern COLON = Pattern.compile(":([a-zA-Z_][a-zA-Z0-9_]*)");
  private static final String INFO = "info";
  private static final String INPUT = "input";
  private static final String SCHEMA = "schema";
  private static final String PROPERTIES = "properties";
  private static final String PATH_PARAMS = "pathParams";
  private static final String METHOD = "method";

  @Override
  public String key() {
    return Bazaar.KEY;
  }

  @Override
  public Object enrichDeclaration(Object declaration, Object transportContext) {
    if (!(transportContext instanceof HttpRequestContext ctx)
        || !(declaration instanceof Map<?, ?> raw)) {
      return declaration;
    }
    Map<String, Object> extension = copy(raw);
    Map<String, Object> infoInput = child(child(extension, INFO), INPUT);
    if ("mcp".equals(infoInput.get("type"))) {
      return declaration;
    }
    String method = ctx.method();

    Map<String, Object> schemaInput = child(child(child(extension, SCHEMA), PROPERTIES), INPUT);
    Map<String, Object> inputProps = copy(child(schemaInput, PROPERTIES));
    inputProps.put(METHOD, mapOf("type", "string", "enum", List.of(method)));
    List<Object> required = new ArrayList<>();
    if (schemaInput.get("required") instanceof List<?> existing) {
      required.addAll(existing);
    }
    if (!required.contains(METHOD)) {
      required.add(METHOD);
    }

    Map<String, Object> result = copy(extension);
    result.put(INFO, withInput(extension, METHOD, method));
    Map<String, Object> newSchemaInput = copy(schemaInput);
    newSchemaInput.put(PROPERTIES, inputProps);
    newSchemaInput.put("required", required);
    result.put(SCHEMA, withSchemaInput(extension, newSchemaInput));

    String rawPattern = ctx.routePattern();
    if (rawPattern == null || rawPattern.isEmpty() || isWildcardOnly(rawPattern)) {
      return result;
    }
    String pattern = normalizeWildcards(rawPattern);
    boolean hasBracket = BRACKET.matcher(pattern).find();
    if (!hasBracket && !COLON.matcher(pattern).find()) {
      return result;
    }
    String template = hasBracket ? BRACKET.matcher(pattern).replaceAll(":$1") : pattern;
    Map<String, Object> pathParams = extractPathParams(template, ctx.adapter().getPath());

    result.put("routeTemplate", template);
    result.put(INFO, withInput(result, PATH_PARAMS, pathParams));
    if (!inputProps.containsKey(PATH_PARAMS)) {
      Map<String, Object> withPath = copy(newSchemaInput);
      Map<String, Object> props = copy(inputProps);
      props.put(PATH_PARAMS, mapOf("type", "object"));
      withPath.put(PROPERTIES, props);
      result.put(SCHEMA, withSchemaInput(result, withPath));
    }
    return result;
  }

  private static Map<String, Object> withInput(
      Map<String, Object> extension, String key, Object value) {
    Map<String, Object> info = copy(child(extension, INFO));
    Map<String, Object> input = copy(child(child(extension, INFO), INPUT));
    input.put(key, value);
    info.put(INPUT, input);
    return info;
  }

  private static Map<String, Object> withSchemaInput(
      Map<String, Object> extension, Map<String, Object> schemaInput) {
    Map<String, Object> schema = copy(child(extension, SCHEMA));
    Map<String, Object> props = copy(child(schema, PROPERTIES));
    props.put(INPUT, schemaInput);
    schema.put(PROPERTIES, props);
    return schema;
  }

  /** Replaces {@code *} segments by {@code :var1}, {@code :var2}, ... */
  private static String normalizeWildcards(String pattern) {
    if (!pattern.contains("*")) {
      return pattern;
    }
    String[] segments = pattern.split("/", -1);
    int counter = 0;
    for (int i = 0; i < segments.length; i++) {
      if ("*".equals(segments[i])) {
        counter++;
        segments[i] = ":var" + counter;
      }
    }
    return String.join("/", segments);
  }

  private static boolean isWildcardOnly(String pattern) {
    boolean any = false;
    for (String segment : pattern.split("/")) {
      if (segment.isEmpty()) {
        continue;
      }
      if (!"*".equals(segment)) {
        return false;
      }
      any = true;
    }
    return any;
  }

  /** Matches the path against a {@code :param} template; no match gives no values. */
  private static Map<String, Object> extractPathParams(String template, String urlPath) {
    List<String> names = new ArrayList<>();
    StringBuilder regex = new StringBuilder("^");
    Matcher matcher = COLON.matcher(template);
    int last = 0;
    while (matcher.find()) {
      regex.append(quote(template.substring(last, matcher.start())));
      names.add(matcher.group(1));
      regex.append("([^/]+)");
      last = matcher.end();
    }
    regex.append(quote(template.substring(last))).append('$');
    Map<String, Object> out = new LinkedHashMap<>();
    Matcher match = Pattern.compile(regex.toString()).matcher(urlPath == null ? "" : urlPath);
    if (urlPath != null && match.matches()) {
      for (int i = 0; i < names.size(); i++) {
        out.put(names.get(i), match.group(i + 1));
      }
    }
    return out;
  }

  private static String quote(String literal) {
    return literal.isEmpty() ? "" : Pattern.quote(literal);
  }

  private static Map<String, Object> child(Map<String, Object> parent, String key) {
    return parent.get(key) instanceof Map<?, ?> value ? copy(value) : new LinkedHashMap<>();
  }

  private static Map<String, Object> copy(Map<?, ?> source) {
    Map<String, Object> out = new LinkedHashMap<>();
    source.forEach((k, v) -> out.put(String.valueOf(k), v));
    return out;
  }

  private static Map<String, Object> mapOf(String k1, Object v1, String k2, Object v2) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put(k1, v1);
    out.put(k2, v2);
    return out;
  }

  private static Map<String, Object> mapOf(String key, Object value) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put(key, value);
    return out;
  }
}
