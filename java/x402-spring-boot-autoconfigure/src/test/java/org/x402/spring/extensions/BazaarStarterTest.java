package org.x402.spring.extensions;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.http.HttpResponse;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.x402.core.types.PaymentRequired;
import org.x402.extensions.bazaar.Bazaar;
import org.x402.extensions.bazaar.HttpDiscoveryConfig;
import org.x402.spring.FakeFacilitator;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestHttp;
import org.x402.spring.annotation.X402Payment;

/** {@code x402.routes.*.extensions.bazaar} from YAML appears in {@code PAYMENT-REQUIRED}. */
@SpringBootTest(classes = BazaarStarterTest.App.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "spring.main.web-application-type=servlet")
class BazaarStarterTest {

  static final FakeFacilitator FACILITATOR = FakeFacilitator.start(HookRecorder.NET);

  @LocalServerPort
  int port;

  @RestController
  static class Controller {
    @X402Payment("weather")
    @GetMapping("/weather/{city}")
    String weather(@PathVariable("city") String city) {
      return city;
    }

    @X402Payment("upload")
    @PostMapping("/upload")
    String upload() {
      return "ok";
    }

    @X402Payment("hidden")
    @GetMapping("/hidden")
    String hidden() {
      return "ok";
    }

    @GetMapping("/report/{name}")
    String report(@PathVariable("name") String name) {
      return name;
    }
  }

  @SpringBootConfiguration
  @EnableAutoConfiguration
  @Import(Controller.class)
  static class App {
    @Bean
    HookRecorder hookRecorder() {
      return new HookRecorder();
    }
  }

  @DynamicPropertySource
  static void properties(DynamicPropertyRegistry r) {
    r.add("x402.facilitators[0].url", FACILITATOR::url);
    r.add("x402.accounts.net.network", () -> "test:net");
    r.add("x402.accounts.net.pay-to", () -> "addr_net");
    for (String offer : List.of("weather", "upload", "hidden", "report")) {
      r.add("x402.routes." + offer + ".accepts[0].account", () -> "net");
      r.add("x402.routes." + offer + ".accepts[0].price", () -> "$0.01");
    }
    r.add("x402.routes.weather.extensions.bazaar.input.units", () -> "metric");
    r.add("x402.routes.weather.extensions.bazaar.input-schema.properties.units.type",
        () -> "string");
    r.add("x402.routes.weather.extensions.bazaar.output.example.forecast", () -> "sunny");
    r.add("x402.routes.upload.extensions.bazaar.body-type", () -> "json");
    r.add("x402.routes.upload.extensions.bazaar.input.name", () -> "file.txt");
    r.add("x402.routes.hidden.extensions.bazaar.discoverable", () -> "false");
    r.add("x402.routes.report.path", () -> "GET /report/*");
    r.add("x402.routes.report.extensions.bazaar.discoverable", () -> "true");
  }

  @AfterAll
  static void stop() {
    FACILITATOR.close();
  }

  private PaymentRequired required(String method, String path) {
    HttpResponse<String> response = TestHttp.send(method, "http://127.0.0.1:" + port + path);
    assertThat(response.statusCode()).isEqualTo(402);
    return TestHttp.required(response);
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> map(Object value) {
    return (Map<String, Object>) value;
  }

  @Test
  void anAnnotatedGetRouteCarriesTheDeclarationWithMethodAndPathParams() {
    Map<String, Object> bazaar = map(required("GET", "/weather/berlin").extensions()
        .get(Bazaar.KEY));
    Map<String, Object> input = map(map(bazaar.get("info")).get("input"));
    assertThat(input).containsEntry("method", "GET")
        .containsEntry("queryParams", Map.of("units", "metric"))
        .containsEntry("pathParams", Map.of("city", "berlin"));
    assertThat(bazaar).containsEntry("routeTemplate", "/weather/:city");
    assertThat(map(map(bazaar.get("info")).get("output")).get("example"))
        .isEqualTo(Map.of("forecast", "sunny"));

    Map<String, Object> expected = map(Bazaar.declareDiscoveryExtension(HttpDiscoveryConfig
        .create().input(Map.of("units", "metric"))
        .inputSchema(Map.of("properties", Map.of("units", Map.of("type", "string"))))
        .output(new org.x402.extensions.bazaar.DiscoveryOutput(Map.of("forecast", "sunny"),
            null))).get(Bazaar.KEY));
    assertThat(map(map(bazaar.get("info")).get("input")).get("type"))
        .isEqualTo(map(map(expected.get("info")).get("input")).get("type"));
  }

  @Test
  void aBodyDeclarationUsesTheMappingsMethod() {
    Map<String, Object> bazaar = map(required("POST", "/upload").extensions().get(Bazaar.KEY));
    Map<String, Object> input = map(map(bazaar.get("info")).get("input"));
    assertThat(input).containsEntry("method", "POST").containsEntry("bodyType", "json")
        .containsEntry("body", Map.of("name", "file.txt"));
  }

  @Test
  void discoverableFalseOmitsTheExtension() {
    PaymentRequired required = required("GET", "/hidden");
    assertThat(required.extensions() == null
        || !required.extensions().containsKey(Bazaar.KEY)).isTrue();
  }

  @Test
  void aYamlPathRouteGetsAWildcardTemplate() {
    Map<String, Object> bazaar = map(required("GET", "/report/q1").extensions()
        .get(Bazaar.KEY));
    assertThat(bazaar).containsEntry("routeTemplate", "/report/:var1");
    assertThat(map(map(bazaar.get("info")).get("input")).get("pathParams"))
        .isEqualTo(Map.of("var1", "q1"));
  }
}
