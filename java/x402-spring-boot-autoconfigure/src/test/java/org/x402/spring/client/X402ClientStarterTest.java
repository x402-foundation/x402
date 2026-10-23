package org.x402.spring.client;

import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.matching;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;
import com.github.tomakehurst.wiremock.verification.LoggedRequest;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.mock.http.client.MockClientHttpRequest;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.client.support.RestClientAdapter;
import org.springframework.web.service.annotation.GetExchange;
import org.springframework.web.service.invoker.HttpServiceProxyFactory;
import org.x402.core.client.X402Client;
import org.x402.core.client.X402ClientException;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.http.HeaderCodec;
import org.x402.http.HostPolicy;
import org.x402.http.X402Headers;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestClientScheme;
import org.x402.spring.X402ClientCustomizer;
import org.x402.spring.client.servlet.X402ClientHttpRequestFactory;
import org.x402.spring.client.servlet.X402ClientHttpRequestFactoryDecorator;

/** Blocking client auto-configuration: Boot builders, self-built beans, the host allowlist. */
@ExtendWith(OutputCaptureExtension.class)
class X402ClientStarterTest {

  private static WireMockServer api;
  private ConfigurableApplicationContext context;

  interface PaidApi {
    @GetExchange("/paid")
    String paid();
  }

  @SpringBootConfiguration
  @EnableAutoConfiguration
  static class ClientApp {
    final TestClientScheme scheme = new TestClientScheme();

    @Bean
    TestClientScheme testClientScheme() {
      return scheme;
    }

    @Bean
    X402ClientCustomizer testSchemes(TestClientScheme scheme) {
      return client -> client.register(HookRecorder.NET, scheme);
    }

    @Bean
    RestClient selfBuiltRestClient() {
      return RestClient.create();
    }

    @Bean
    RestTemplate selfBuiltRestTemplate() {
      return new RestTemplate();
    }

    @Bean
    RestClient decoratedRestClient(X402ClientHttpRequestFactoryDecorator x402Decorator) {
      return RestClient.builder()
          .requestFactory(x402Decorator.decorate(new JdkClientHttpRequestFactory())).build();
    }

    @Bean
    RestClient bootBuiltRestClient(RestClient.Builder builder) {
      return builder.build();
    }
  }

  @BeforeAll
  static void startApi() {
    api = new WireMockServer(WireMockConfiguration.options().dynamicPort());
    api.start();
  }

  @AfterAll
  static void stopApi() {
    api.stop();
  }

  @BeforeEach
  void stubs() {
    api.resetAll();
    stub402("/paid", requirement("USDM", "10000"), api.baseUrl() + "/paid", 0);
    stub402("/over-cap", requirement("USDM", "2000000"), api.baseUrl() + "/over-cap", 0);
    stub402("/lovelace", requirement("lovelace", "1000000"), api.baseUrl() + "/lovelace", 0);
    stub402("/evil", requirement("USDM", "10000"), "https://evil.example/x", 0);
    stub402("/slow", requirement("USDM", "10000"), api.baseUrl() + "/slow", 1500);
  }

  @AfterEach
  void close() {
    if (context != null) {
      context.close();
    }
  }

  private static PaymentRequirements requirement(String asset, String amount) {
    return new PaymentRequirements("exact", HookRecorder.NET, asset, amount, "addr_seller", 300,
        Map.of());
  }

  private static void stub402(String path, PaymentRequirements requirements, String resource,
      int paidDelay) {
    String header = HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(resource), List.of(requirements), null));
    api.stubFor(get(urlEqualTo(path)).withHeader(X402Headers.PAYMENT_SIGNATURE, absent())
        .willReturn(aResponse().withStatus(402).withHeader(X402Headers.PAYMENT_REQUIRED, header)
            .withHeader("Content-Type", "application/json").withBody("{}")));
    api.stubFor(get(urlEqualTo(path)).withHeader(X402Headers.PAYMENT_SIGNATURE, matching(".+"))
        .willReturn(aResponse().withStatus(200).withBody("paid").withFixedDelay(paidDelay)));
  }

  private ConfigurableApplicationContext start(String... properties) {
    List<String> all = new ArrayList<>(List.of(
        "spring.main.web-application-type=none",
        "x402.client.enabled=true",
        "x402.client.hosts[0]=localhost"));
    all.addAll(List.of(properties));
    context = new SpringApplicationBuilder(ClientApp.class)
        .properties(all.toArray(String[]::new)).run();
    return context;
  }

  private String url(String path) {
    return api.baseUrl() + path;
  }

  private int paidRequests(String path) {
    return api.countRequestsMatching(getRequestedFor(urlEqualTo(path))
        .withHeader(X402Headers.PAYMENT_SIGNATURE, matching(".+")).build()).getCount();
  }

  private TestClientScheme scheme() {
    return context.getBean(TestClientScheme.class);
  }

  @Test
  void clientsFromBootBuildersPayA402FromAnAllowedHost() {
    start();
    RestClient restClient = context.getBean(RestClient.Builder.class).build();
    assertThat(restClient.get().uri(url("/paid")).retrieve().body(String.class)).isEqualTo("paid");

    RestTemplate restTemplate = context.getBean(RestTemplateBuilder.class).build();
    assertThat(restTemplate.getForObject(url("/paid"), String.class)).isEqualTo("paid");

    PaidApi exchange = HttpServiceProxyFactory.builderFor(RestClientAdapter.create(
        context.getBean(RestClient.Builder.class).baseUrl(api.baseUrl()).build()))
        .build().createClient(PaidApi.class);
    assertThat(exchange.paid()).isEqualTo("paid");

    assertThat(paidRequests("/paid")).isEqualTo(3);
    assertThat(scheme().signed).hasSize(3);
  }

  @Test
  void selfBuiltRestClientAndRestTemplateBeansAreLeftUnchangedWithAWarning(
      CapturedOutput output) {
    start();
    RestClient self = context.getBean("selfBuiltRestClient", RestClient.class);
    assertThatThrownBy(() -> self.get().uri(url("/paid")).retrieve().body(String.class))
        .isInstanceOf(HttpClientErrorException.class)
        .satisfies(e -> assertThat(((HttpClientErrorException) e).getStatusCode().value())
            .isEqualTo(402));
    RestTemplate template = context.getBean("selfBuiltRestTemplate", RestTemplate.class);
    assertThatThrownBy(() -> template.getForObject(url("/paid"), String.class))
        .isInstanceOf(HttpClientErrorException.class);
    assertThat(paidRequests("/paid")).isZero();

    String logs = output.getOut() + output.getErr();
    assertThat(logs).contains("selfBuiltRestClient").contains("selfBuiltRestTemplate")
        .contains("x402Decorator.decorate(");
  }

  @Test
  void decoratedSelfBuiltClientPaysAndFollowsTheAllowlist() {
    start();
    RestClient decorated = context.getBean("decoratedRestClient", RestClient.class);
    assertThat(decorated.get().uri(url("/paid")).retrieve().body(String.class)).isEqualTo("paid");
    context.close();

    start("x402.client.hosts[0]=api.example.com");
    RestClient offList = context.getBean("decoratedRestClient", RestClient.class);
    assertThatThrownBy(() -> offList.get().uri(url("/paid")).retrieve().body(String.class))
        .isInstanceOf(HttpClientErrorException.class);
    context.close();

    context = new SpringApplicationBuilder(ClientApp.class).properties(
        "spring.main.web-application-type=none", "x402.client.enabled=true").run();
    RestClient empty = context.getBean("decoratedRestClient", RestClient.class);
    assertThatThrownBy(() -> empty.get().uri(url("/paid")).retrieve().body(String.class))
        .isInstanceOf(HttpClientErrorException.class);
    assertThat(paidRequests("/paid")).isEqualTo(1);
  }

  @Test
  void aBootBuiltClientExposedAsABeanIsInstrumentedOnceAndNotWarnedAbout(
      CapturedOutput output) {
    start();
    RestClient boot = context.getBean("bootBuiltRestClient", RestClient.class);
    assertThat(boot.get().uri(url("/paid")).retrieve().body(String.class)).isEqualTo("paid");
    assertThat(scheme().signed).hasSize(1);
    assertThat(api.countRequestsMatching(getRequestedFor(urlEqualTo("/paid")).build())
        .getCount()).isEqualTo(2);
    assertThat(output.getOut() + output.getErr()).doesNotContain("bootBuiltRestClient")
        .doesNotContain("decoratedRestClient");
  }

  @Test
  void anOffListHostOrAnEmptyListGetsThe402BackUnpaid(CapturedOutput output) {
    start("x402.client.hosts[0]=api.example.com");
    RestClient client = context.getBean(RestClient.Builder.class).build();
    assertThatThrownBy(() -> client.get().uri(url("/paid")).retrieve().body(String.class))
        .isInstanceOf(HttpClientErrorException.class);
    context.close();

    context = new SpringApplicationBuilder(ClientApp.class).properties(
        "spring.main.web-application-type=none", "x402.client.enabled=true").run();
    RestClient none = context.getBean(RestClient.Builder.class).build();
    assertThatThrownBy(() -> none.get().uri(url("/paid")).retrieve().body(String.class))
        .isInstanceOf(HttpClientErrorException.class);
    assertThat(paidRequests("/paid")).isZero();
    assertThat(scheme().signed).isEmpty();
    assertThat(output.getOut() + output.getErr()).contains("x402.client.hosts");
  }

  @Test
  void a402WhoseResourceUrlHostIsOffTheListIsNotPaid() {
    start();
    RestClient client = context.getBean(RestClient.Builder.class).build();
    assertThatThrownBy(() -> client.get().uri(url("/evil")).retrieve().body(String.class))
        .isInstanceOf(HttpClientErrorException.class);
    assertThat(paidRequests("/evil")).isZero();
  }

  @Test
  void overCapAndNonDefaultAssetsAreRefusedUnlessAllowed() {
    start();
    RestClient client = context.getBean(RestClient.Builder.class).build();
    assertThatThrownBy(() -> client.get().uri(url("/over-cap")).retrieve().body(String.class))
        .hasRootCauseInstanceOf(X402ClientException.class);
    assertThatThrownBy(() -> client.get().uri(url("/lovelace")).retrieve().body(String.class))
        .hasRootCauseInstanceOf(X402ClientException.class);
    assertThat(paidRequests("/over-cap") + paidRequests("/lovelace")).isZero();
    context.close();

    start("x402.client.spend-controls.allowed-assets[0].network=test:net",
        "x402.client.spend-controls.allowed-assets[0].asset=lovelace");
    RestClient allowed = context.getBean(RestClient.Builder.class).build();
    assertThat(allowed.get().uri(url("/lovelace")).retrieve().body(String.class))
        .isEqualTo("paid");
  }

  @Test
  void interceptorsBeforeX402AreNotRerunAndTheirStaticHeadersStayOnThePaidRetry() {
    start();
    RestClient client = context.getBean(RestClient.Builder.class)
        .requestInterceptor((request, body, execution) -> {
          request.getHeaders().add("X-Api-Key", "secret");
          request.getHeaders().add("X-Signed-Headers",
              String.join(",", request.getHeaders().keySet()).toLowerCase());
          return execution.execute(request, body);
        }).build();
    assertThat(client.get().uri(url("/paid")).retrieve().body(String.class)).isEqualTo("paid");

    List<LoggedRequest> paid = api.findAll(getRequestedFor(urlEqualTo("/paid"))
        .withHeader(X402Headers.PAYMENT_SIGNATURE, matching(".+")));
    assertThat(paid).hasSize(1);
    assertThat(paid.get(0).getHeader("X-Api-Key")).isEqualTo("secret");
    // Documented limitation: a header-signing step before x402 never covers PAYMENT-SIGNATURE.
    assertThat(paid.get(0).getHeader("X-Signed-Headers")).doesNotContain("payment-signature");
  }

  @Test
  void aCustomFactorySettingSurvivesInstrumentation() {
    start("spring.http.client.factory=jdk", "spring.http.client.read-timeout=500ms");
    RestClient client = context.getBean(RestClient.Builder.class).build();
    assertThatThrownBy(() -> client.get().uri(url("/slow")).retrieve().body(String.class))
        .isInstanceOf(ResourceAccessException.class);
    assertThat(paidRequests("/slow")).isEqualTo(1);
  }

  @Test
  void wildcardHostsMatchSubdomainsButNotTheApexAndTheFirst402IsClosedFirst() throws Exception {
    X402Client x402 = new X402Client();
    TestClientScheme scheme = new TestClientScheme();
    x402.register(HookRecorder.NET, scheme);
    List<String> events = new ArrayList<>();
    ClientHttpRequestFactory fake = (uri, method) -> new MockClientHttpRequest(method, uri) {
      @Override
      protected ClientHttpResponse executeInternal() {
        boolean signed = getHeaders().containsKey(X402Headers.PAYMENT_SIGNATURE);
        events.add((signed ? "paid " : "send ") + uri.getHost());
        return new RecordingResponse(signed ? HttpStatus.OK : HttpStatus.PAYMENT_REQUIRED,
            signed ? Map.of() : Map.of(X402Headers.PAYMENT_REQUIRED, header(uri)),
            () -> events.add("closed " + uri.getHost() + (signed ? " paid" : " 402")));
      }
    };
    ClientHttpRequestFactory wrapped = X402ClientHttpRequestFactory.wrap(fake, x402,
        HostPolicy.of(List.of("*.example.com")));
    assertThat(X402ClientHttpRequestFactory.wrap(wrapped, x402,
        HostPolicy.of(List.of("*.example.com")))).isSameAs(wrapped);

    try (ClientHttpResponse sub = wrapped.createRequest(
        URI.create("https://api.example.com/x"), HttpMethod.GET).execute()) {
      assertThat(sub.getStatusCode().value()).isEqualTo(200);
    }
    try (ClientHttpResponse apex = wrapped.createRequest(
        URI.create("https://example.com/x"), HttpMethod.GET).execute()) {
      assertThat(apex.getStatusCode().value()).isEqualTo(402);
    }
    assertThat(events).containsSubsequence("send api.example.com", "closed api.example.com 402",
        "paid api.example.com");
    assertThat(events).doesNotContain("paid example.com");
    assertThat(scheme.signed).hasSize(1);
  }

  private static String header(URI uri) {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(uri.toString()), List.of(requirement("USDM", "10000")), null));
  }

  /** A response recording its close. */
  static final class RecordingResponse implements ClientHttpResponse {
    private final HttpStatusCode status;
    private final HttpHeaders headers = new HttpHeaders();
    private final Runnable onClose;

    RecordingResponse(HttpStatusCode status, Map<String, String> headers, Runnable onClose) {
      this.status = status;
      new LinkedHashMap<>(headers).forEach(this.headers::add);
      this.onClose = onClose;
    }

    @Override
    public HttpStatusCode getStatusCode() {
      return status;
    }

    @Override
    public String getStatusText() {
      return "";
    }

    @Override
    public void close() {
      onClose.run();
    }

    @Override
    public InputStream getBody() {
      return new ByteArrayInputStream(new byte[0]);
    }

    @Override
    public HttpHeaders getHeaders() {
      return headers;
    }
  }
}
