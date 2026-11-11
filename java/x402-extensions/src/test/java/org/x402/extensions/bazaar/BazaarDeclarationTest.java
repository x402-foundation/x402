package org.x402.extensions.bazaar;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.x402.core.json.X402Json;
import org.x402.http.HttpAdapter;
import org.x402.http.HttpRequestContext;

/** Output equals the vectors exported from the TypeScript SDK (key order included). */
class BazaarDeclarationTest {

  private static final ObjectMapper MAPPER = X402Json.mapper();
  private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {};

  static Stream<JsonNode> declareCases() throws IOException {
    return cases("declare");
  }

  static Stream<JsonNode> enrichCases() throws IOException {
    return cases("enrich");
  }

  private static Stream<JsonNode> cases(String kind) throws IOException {
    try (InputStream in =
        BazaarDeclarationTest.class.getResourceAsStream("/vectors/bazaar.json")) {
      JsonNode doc = MAPPER.readTree(in);
      List<JsonNode> out = new ArrayList<>();
      doc.get("cases")
          .forEach(
              c -> {
                if (kind.equals(c.get("kind").asText())) {
                  out.add(c);
                }
              });
      return out.stream();
    }
  }

  private static Map<String, Object> map(JsonNode node) {
    return MAPPER.convertValue(node, MAP);
  }

  private static DiscoveryOutput output(JsonNode config) {
    JsonNode out = config.get("output");
    if (out == null) {
      return null;
    }
    return new DiscoveryOutput(
        out.has("example") ? MAPPER.convertValue(out.get("example"), Object.class) : null,
        out.has("schema") ? map(out.get("schema")) : null);
  }

  private static Map<String, Object> declare(JsonNode config) {
    if (config.has("toolName")) {
      McpDiscoveryConfig mcp =
          McpDiscoveryConfig.of(
                  config.get("toolName").asText(), map(config.get("inputSchema")))
              .output(output(config));
      if (config.has("description")) {
        mcp.description(config.get("description").asText());
      }
      if (config.has("transport")) {
        mcp.transport(config.get("transport").asText());
      }
      if (config.has("example")) {
        mcp.example(map(config.get("example")));
      }
      return Bazaar.declareDiscoveryExtension(mcp);
    }
    HttpDiscoveryConfig http = HttpDiscoveryConfig.create().output(output(config));
    if (config.has("method")) {
      http.method(config.get("method").asText());
    }
    if (config.has("bodyType")) {
      http.bodyType(config.get("bodyType").asText());
    }
    if (config.has("input")) {
      http.input(map(config.get("input")));
    }
    if (config.has("inputSchema")) {
      http.inputSchema(map(config.get("inputSchema")));
    }
    if (config.has("pathParams")) {
      http.pathParams(map(config.get("pathParams")));
    }
    if (config.has("pathParamsSchema")) {
      http.pathParamsSchema(map(config.get("pathParamsSchema")));
    }
    return Bazaar.declareDiscoveryExtension(http);
  }

  private static void assertSameJson(Object actual, JsonNode expected) {
    assertThat(X402Json.write(actual)).isEqualTo(X402Json.write(expected));
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("declareCases")
  void declarationEqualsTs(JsonNode vector) {
    Map<String, Object> declared = declare(vector.get("config"));
    assertThat(declared).containsOnlyKeys("bazaar");
    assertSameJson(declared.get("bazaar"), vector.get("expected"));
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("enrichCases")
  void enrichmentEqualsTs(JsonNode vector) {
    Object declaration = map(vector.get("declaration"));
    JsonNode ctx = vector.get("context");
    Object context =
        ctx.isNull() ? Map.of("something", "else") : httpContext(ctx);
    Object enriched = new BazaarServerExtension().enrichDeclaration(declaration, context);
    assertSameJson(enriched, vector.get("expected"));
  }

  @Test
  void aMissingBodyTypeIsRejectedAsInvalid() {
    assertThatThrownBy(() -> HttpDiscoveryConfig.create().bodyType(null))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("bodyType must be one of");
  }

  @Test
  void enrichmentDoesNotMutateTheDeclaration() throws IOException {
    JsonNode vector = enrichCases().findFirst().orElseThrow();
    Map<String, Object> declaration = map(vector.get("declaration"));
    String before = X402Json.write(declaration);
    new BazaarServerExtension().enrichDeclaration(declaration, httpContext(vector.get("context")));
    assertThat(X402Json.write(declaration)).isEqualTo(before);
  }

  @Test
  void nonMapDeclarationIsReturnedUnchanged() {
    Object context = httpContext(MAPPER.createObjectNode().put("method", "GET").put("path", "/"));
    assertThat(new BazaarServerExtension().enrichDeclaration("text", context)).isEqualTo("text");
  }

  @Test
  void extensionKeyIsBazaar() {
    assertThat(new BazaarServerExtension().key()).isEqualTo("bazaar");
    assertThat(Bazaar.KEY).isEqualTo("bazaar");
  }

  @Test
  void bodyTypeMustBeKnownAndMcpNeedsAToolName() {
    assertThatThrownBy(() -> HttpDiscoveryConfig.create().bodyType("xml"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> McpDiscoveryConfig.of(null, new LinkedHashMap<>()))
        .isInstanceOf(NullPointerException.class);
  }

  private static HttpRequestContext httpContext(JsonNode ctx) {
    String path = ctx.get("path").asText();
    HttpAdapter adapter =
        new HttpAdapter() {
          @Override
          public String getHeader(String name) {
            return null;
          }

          @Override
          public String getMethod() {
            return ctx.get("method").asText();
          }

          @Override
          public String getPath() {
            return path;
          }

          @Override
          public String getUrl() {
            return "http://localhost" + path;
          }
        };
    String pattern = ctx.has("routePattern") ? ctx.get("routePattern").asText() : null;
    return new HttpRequestContext(adapter, ctx.get("method").asText(), path, null, pattern);
  }
}
