package org.x402.spring.extensions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.extensions.bazaar.Bazaar;
import org.x402.http.RouteConfig;
import org.x402.spring.X402ConfigurationException;

/** Edge cases of the YAML → bazaar declaration mapping. */
class BazaarDeclarationsTest {

  private final BazaarDeclarations declarations = new BazaarDeclarations();

  private static RouteConfig route(Object bazaar) {
    Map<String, Object> extensions = new LinkedHashMap<>();
    extensions.put(Bazaar.KEY, bazaar);
    extensions.put("other", Map.of("k", "v"));
    return RouteConfig.builder().extensions(extensions).build();
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> map(Object value) {
    return (Map<String, Object>) value;
  }

  @Test
  void routesWithoutBazaarAreUnchanged() {
    RouteConfig plain = RouteConfig.builder().build();
    assertThat(declarations.customize("r", plain)).isSameAs(plain);
    RouteConfig other = RouteConfig.builder().extensions(Map.of("x", 1)).build();
    assertThat(declarations.customize("r", other)).isSameAs(other);
  }

  @Test
  void scalarTrueDeclaresDefaultsAndFalseRemovesTheExtension() {
    assertThat(declarations.customize("r", route("true")).extensions())
        .containsKey(Bazaar.KEY).containsKey("other");
    assertThat(declarations.customize("r", route(Boolean.FALSE)).extensions())
        .doesNotContainKey(Bazaar.KEY).containsKey("other");
    RouteConfig onlyBazaar = RouteConfig.builder()
        .extensions(Map.of(Bazaar.KEY, Map.of("discoverable", false))).build();
    assertThat(declarations.customize("r", onlyBazaar).extensions()).isNull();
  }

  @Test
  void camelCaseKeysPathParamsSchemasAndIndexedListsAreHonoured() {
    Map<String, Object> yaml = new LinkedHashMap<>();
    yaml.put("method", "GET");
    yaml.put("pathParams", Map.of("city", "berlin"));
    yaml.put("pathParamsSchema", Map.of("properties", Map.of("city", Map.of("type", "string"))));
    yaml.put("inputSchema", Map.of("required", Map.of("0", "units", "1", "lang")));
    yaml.put("bodyType", "text");
    yaml.put("output", Map.of("example", "ok", "schema", Map.of("type", "string")));
    Map<String, Object> bazaar = map(declarations.customize("r", route(yaml)).extensions()
        .get(Bazaar.KEY));
    Map<String, Object> input = map(map(bazaar.get("info")).get("input"));
    assertThat(input).containsEntry("method", "GET").containsEntry("bodyType", "text");
    assertThat(String.valueOf(bazaar.get("schema"))).contains("[units, lang]");
    assertThat(org.x402.spring.properties.RawProperties.restoreLists(List.of(Map.of("0", "a")))).isEqualTo(
        List.of(List.of("a")));
  }

  @Test
  void invalidDeclarationsFailStartup() {
    assertThatThrownBy(() -> declarations.customize("r", route(Map.of("discover", true))))
        .isInstanceOf(X402ConfigurationException.class).hasMessageContaining("\"discover\"");
    assertThatThrownBy(() -> declarations.customize("r", route(Map.of("body-type", "xml"))))
        .isInstanceOf(X402ConfigurationException.class).hasMessageContaining("body-type");
    assertThatThrownBy(() -> declarations.customize("r", route(Map.of("input", "units"))))
        .isInstanceOf(X402ConfigurationException.class).hasMessageContaining("object");
  }

  @Test
  void aReadyDeclarationFromACustomizerPassesThrough() {
    Object declared = Bazaar.declareDiscoveryExtension(
        org.x402.extensions.bazaar.HttpDiscoveryConfig.create()).get(Bazaar.KEY);

    RouteConfig out = declarations.customize("r", route(declared));

    assertThat(out.extensions()).containsEntry(Bazaar.KEY, declared);
  }

  @Test
  void theYamlConverterRunsBeforeUserCustomizers() {
    assertThat(org.springframework.core.annotation.OrderUtils.getOrder(BazaarDeclarations.class))
        .isEqualTo(org.springframework.core.Ordered.HIGHEST_PRECEDENCE);
  }
}

