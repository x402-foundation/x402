package org.x402.spring.offer;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.json.X402Json;
import org.x402.extensions.bazaar.Bazaar;
import org.x402.http.RouteConfig;
import org.x402.spring.TestBinding;
import org.x402.spring.extensions.BazaarDeclarations;

/**
 * YAML lists bind to index-keyed maps inside free-form values; every extension value and every
 * {@code accepts[].extra} comes out of the resolver as a real list, so PAYMENT-REQUIRED carries
 * JSON arrays.
 */
class YamlListsInOffersTest {

  private static X402Offers resolve(String... kv) {
    String[] base = {
        "x402.accounts.net.network", "test:net",
        "x402.accounts.net.pay-to", "addr",
        "x402.routes.r.accepts[0].account", "net",
        "x402.routes.r.accepts[0].price", "$0.01"};
    String[] all = new String[base.length + kv.length];
    System.arraycopy(base, 0, all, 0, base.length);
    System.arraycopy(kv, 0, all, base.length, kv.length);
    TestBinding.Bound bound = TestBinding.bind(all);
    return OfferResolver.builder(bound.properties()).presence(bound.present())
        .routeCustomizers(List.of(new BazaarDeclarations()))
        .facilitators(List.of("https://f")).build().resolve();
  }

  @Test
  void aNonBazaarExtensionKeepsItsLists() {
    RouteConfig route = resolve("x402.routes.r.extensions.custom.required[0]", "type",
        "x402.routes.r.extensions.custom.required[1]", "method",
        "x402.routes.r.extensions.custom.nested.kind[0]", "a").offer("r").route();

    Map<?, ?> custom = (Map<?, ?>) route.extensions().get("custom");
    assertThat(custom.get("required")).isEqualTo(List.of("type", "method"));
    assertThat(((Map<?, ?>) custom.get("nested")).get("kind")).isEqualTo(List.of("a"));
    assertThat(X402Json.write(route.extensions())).contains("[\"type\",\"method\"]");
  }

  @Test
  void acceptsExtraKeepsItsLists() {
    RouteConfig route = resolve("x402.routes.r.accepts[0].extra.options[0]", "x",
        "x402.routes.r.accepts[0].extra.options[1]", "y").offer("r").route();

    Object options = route.accepts().get(0).extra().get("options");
    assertThat(options).isEqualTo(List.of("x", "y"));
  }

  @Test
  void aReadyBazaarDeclarationKeepsItsListsAndEnums() {
    RouteConfig route = resolve(
        "x402.routes.r.extensions.bazaar.info.input.type", "http",
        "x402.routes.r.extensions.bazaar.schema.required[0]", "type",
        "x402.routes.r.extensions.bazaar.schema.required[1]", "method",
        "x402.routes.r.extensions.bazaar.schema.properties.method.enum[0]", "GET",
        "x402.routes.r.extensions.bazaar.schema.properties.method.enum[1]", "HEAD")
        .offer("r").route();

    String json = X402Json.write(route.extensions().get(Bazaar.KEY));
    assertThat(json).contains("\"required\":[\"type\",\"method\"]")
        .contains("\"enum\":[\"GET\",\"HEAD\"]");
  }
}
