package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.x402.core.json.X402Json;

/**
 * Route pattern parsing and path normalization, checked against the vectors exported from the
 * TypeScript SDK ({@code vectors/route-patterns.json}).
 */
class RoutePatternParityTest {

  private static JsonNode cases() throws IOException {
    try (InputStream in = RoutePatternParityTest.class
        .getResourceAsStream("/vectors/route-patterns.json")) {
      return X402Json.mapper().readTree(in).get("cases");
    }
  }

  @TestFactory
  Stream<DynamicTest> everyPatternParsesAndMatchesLikeTs() throws IOException {
    List<DynamicTest> tests = new ArrayList<>();
    for (JsonNode route : cases().get("routes")) {
      String pattern = route.get("pattern").asText();
      tests.add(DynamicTest.dynamicTest(pattern, () -> {
        RoutePattern parsed = RoutePattern.parse(pattern);
        assertThat(parsed.verb()).isEqualTo(route.get("verb").asText());
        assertThat(parsed.path()).isEqualTo(route.get("path").asText());
        for (JsonNode m : route.get("matches")) {
          String path = m.get("path").asText();
          String normalized = RoutePattern.normalizePath(path);
          assertThat(normalized).as("normalizePath(%s)", path)
              .isEqualTo(m.get("normalized").asText());
          assertThat(parsed.matchesNormalized(normalized)).as("%s ~ %s", pattern, path)
              .isEqualTo(m.get("match").asBoolean());
        }
      }));
    }
    return tests.stream();
  }

  @Test
  void decodedPathsNormalizeLikeTs() throws IOException {
    for (JsonNode c : cases().get("decoded")) {
      assertThat(RoutePattern.normalizeDecodedPath(c.get("path").asText()))
          .as(c.get("path").asText()).isEqualTo(c.get("normalized").asText());
    }
  }

  @Test
  void theResolverChecksVerbThenFallsBackToTheDecodedPath() {
    RouteConfig weather = RouteConfig.builder().build();
    RouteConfig items = RouteConfig.builder().build();
    Map<String, RouteConfig> routes = new LinkedHashMap<>();
    routes.put("GET /weather", weather);
    routes.put("/items/:id", items);
    PatternRouteResolver resolver = new PatternRouteResolver(routes);

    RouteMatch m = resolver.resolve(TestAdapter.get("/weather").context());
    assertThat(m.key()).isEqualTo("GET /weather");
    assertThat(m.pattern()).isEqualTo("/weather");
    assertThat(m.config()).isSameAs(weather);
    assertThat(resolver.resolve(TestAdapter.request("POST", "/weather").context())).isNull();
    assertThat(resolver.resolve(TestAdapter.request("post", "/items/1").context()).config())
        .isSameAs(items);

    // raw path "/items/a/b" does not match ":id"; a decoded path is tried second
    HttpRequestContext raw = TestAdapter.get("/nope/x").context().withPaths("/nope/x", "/items/7");
    assertThat(resolver.resolve(raw).config()).isSameAs(items);
    assertThat(resolver.routes()).containsOnlyKeys("GET /weather", "/items/:id");
    assertThat(PatternRouteResolver.single(weather).resolve(TestAdapter.get("/x/y").context())
        .config()).isSameAs(weather);
  }
}
