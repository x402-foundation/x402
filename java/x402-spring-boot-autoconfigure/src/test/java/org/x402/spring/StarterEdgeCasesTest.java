package org.x402.spring;

import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.matching;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;
import com.github.tomakehurst.wiremock.verification.LoggedRequest;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.net.URI;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.MultipartBodyBuilder;
import org.springframework.http.client.reactive.JdkClientHttpConnector;
import org.springframework.mock.http.client.MockClientHttpRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.x402.core.PaymentFlow;
import org.x402.core.SchemeNetworkServer;
import org.x402.core.client.X402Client;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.Price;
import org.x402.core.types.SupportedKind;
import org.x402.http.HeaderCodec;
import org.x402.http.HostPolicy;
import org.x402.http.HttpProcessResult;
import org.x402.http.X402Headers;
import org.x402.http.X402HttpResourceServer;
import org.x402.spring.autoconfigure.X402AutoConfiguration;
import org.x402.spring.client.TransportRedirects;
import org.x402.spring.client.reactive.X402ExchangeFilterFunction;
import org.x402.spring.client.servlet.X402ClientHttpRequestFactory;
import org.x402.spring.offer.HandlerMethodSource;
import org.x402.spring.offer.OfferRegistry;
import org.x402.spring.offer.OfferResolver;
import org.x402.spring.offer.X402Offers;
import org.x402.spring.web.servlet.ServletHandlerMethodSource;
import reactor.core.publisher.Mono;

/** Starter edge cases: replay headers, price extras, missing resource URL, hooks, startup. */
@ExtendWith(OutputCaptureExtension.class)
class StarterEdgeCasesTest {

  private static WireMockServer api;
  private static FakeFacilitator a;
  private static FakeFacilitator b;

  @BeforeAll
  static void start() {
    api = new WireMockServer(WireMockConfiguration.options().dynamicPort());
    api.start();
    a = FakeFacilitator.start(HookRecorder.NET);
    b = FakeFacilitator.start(HookRecorder.MAIN);
  }

  @AfterAll
  static void stop() {
    api.stop();
    a.close();
    b.close();
  }

  private static String required(String resource) {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        resource == null ? null : org.x402.core.types.ResourceInfo.of(resource),
        List.of(new PaymentRequirements("exact", HookRecorder.NET, "USDM", "10000", "addr", 300,
            Map.of())), null));
  }

  // ------------------------------------------------------------ WebClient replay headers

  @Test
  void webClientReplayKeepsTheHeadersTheBodyWriterSet() {
    api.resetAll();
    api.stubFor(post(urlEqualTo("/upload")).withHeader(X402Headers.PAYMENT_SIGNATURE, absent())
        .willReturn(aResponse().withStatus(402)
            .withHeader(X402Headers.PAYMENT_REQUIRED, required(api.baseUrl() + "/upload"))));
    api.stubFor(post(urlEqualTo("/upload")).withHeader(X402Headers.PAYMENT_SIGNATURE,
        matching(".+")).willReturn(aResponse().withStatus(200).withBody("stored")));
    X402Client client = new X402Client().register(HookRecorder.NET, new TestClientScheme());
    JdkClientHttpConnector connector = new JdkClientHttpConnector(
        java.net.http.HttpClient.newBuilder().version(java.net.http.HttpClient.Version.HTTP_1_1)
            .followRedirects(java.net.http.HttpClient.Redirect.NEVER).build());
    WebClient web = WebClient.builder().clientConnector(connector)
        .filter(new X402ExchangeFilterFunction(client, HostPolicy.of(List.of("localhost")),
            1 << 20).forTransport(TransportRedirects.of(connector))).build();

    assertThat(web.post().uri(api.baseUrl() + "/upload").bodyValue(Map.of("q", 1)).retrieve()
        .bodyToMono(String.class).block()).isEqualTo("stored");
    MultipartBodyBuilder parts = new MultipartBodyBuilder();
    parts.part("file", "content-of-file");
    assertThat(web.post().uri(api.baseUrl() + "/upload")
        .body(BodyInserters.fromMultipartData(parts.build())).retrieve()
        .bodyToMono(String.class).block()).isEqualTo("stored");

    List<LoggedRequest> paid = api.findAll(postRequestedFor(urlEqualTo("/upload"))
        .withHeader(X402Headers.PAYMENT_SIGNATURE, matching(".+")));
    assertThat(paid).hasSize(2);
    assertThat(paid.get(0).getHeader("Content-Type")).startsWith("application/json");
    String multipart = paid.get(1).getHeader("Content-Type");
    assertThat(multipart).startsWith("multipart/form-data").contains("boundary=");
    String boundary = multipart.substring(multipart.indexOf("boundary=") + 9);
    assertThat(paid.get(1).getBodyAsString()).contains(boundary)
        .contains("content-of-file");
  }

  // ------------------------------------------------------------ transfer method in price extra

  @Test
  void aTransferMethodOnlyInPriceExtraIsSeenAtStartup() {
    WebApplicationContextRunner runner = new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class))
        .withBean(HookRecorder.class)
        .withPropertyValues(
            "x402.facilitators[0].url=" + a.url(),
            "x402.routes.r.accepts[0].network=test:net",
            "x402.routes.r.accepts[0].pay-to=addr",
            "x402.routes.r.accepts[0].price.amount=10",
            "x402.routes.r.accepts[0].price.asset=USDM");
    runner.withPropertyValues("x402.routes.r.accepts[0].price.extra.assetTransferMethod=prepaid")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(ctx.getBean(X402Offers.class).offer("r").route().accepts().get(0).extra())
              .containsEntry("assetTransferMethod", "prepaid");
        });
    runner.withPropertyValues("x402.routes.r.accepts[0].price.extra.assetTransferMethod=nope")
        .run(ctx -> assertThat(ctx).hasFailed());
  }

  // ------------------------------------------------------------ 402 without resource URL

  @Test
  void a402WithoutResourceUrlIsNotPaid() throws Exception {
    TestClientScheme scheme = new TestClientScheme();
    X402Client client = new X402Client().register(HookRecorder.NET, scheme);
    ClientHttpRequestFactory fake = (uri, method) -> new MockClientHttpRequest(method, uri) {
      @Override
      protected ClientHttpResponse executeInternal() {
        return response(HttpStatus.PAYMENT_REQUIRED, Map.of(X402Headers.PAYMENT_REQUIRED,
            required(null)), () -> { });
      }
    };
    ClientHttpRequestFactory blocking = X402ClientHttpRequestFactory.wrap(fake, client,
        HostPolicy.of(List.of("api.example.com")));
    try (ClientHttpResponse r = blocking.createRequest(URI.create("https://api.example.com/x"),
        HttpMethod.GET).execute()) {
      assertThat(r.getStatusCode().value()).isEqualTo(402);
    }

    X402ExchangeFilterFunction reactive = new X402ExchangeFilterFunction(client,
        HostPolicy.of(List.of("api.example.com")), 1024)
        .forTransport(TransportRedirects.Safety.SAFE);
    ClientResponse unpaid = reactive.filter(ClientRequest.create(HttpMethod.GET,
        URI.create("https://api.example.com/x")).build(), r -> Mono.just(ClientResponse
            .create(HttpStatus.PAYMENT_REQUIRED)
            .header(X402Headers.PAYMENT_REQUIRED, required(null)).build())).block();
    assertThat(unpaid.statusCode().value()).isEqualTo(402);
    assertThat(scheme.signed).isEmpty();
  }

  // ------------------------------------------------------------ payment response hook failure

  @Test
  void aThrowingPaymentResponseHookStillClosesThePaidResponse() {
    X402Client client = new X402Client().register(HookRecorder.NET, new TestClientScheme());
    client.onPaymentResponse(ctx -> {
      throw new IllegalStateException("hook failed");
    });
    List<String> closed = new ArrayList<>();
    ClientHttpRequestFactory fake = (uri, method) -> new MockClientHttpRequest(method, uri) {
      @Override
      protected ClientHttpResponse executeInternal() {
        boolean paid = getHeaders().containsKey(X402Headers.PAYMENT_SIGNATURE);
        return paid ? response(HttpStatus.OK, Map.of(), () -> closed.add("paid"))
            : response(HttpStatus.PAYMENT_REQUIRED, Map.of(X402Headers.PAYMENT_REQUIRED,
                required("https://api.example.com/x")), () -> closed.add("unpaid"));
      }
    };
    ClientHttpRequestFactory blocking = X402ClientHttpRequestFactory.wrap(fake, client,
        HostPolicy.of(List.of("api.example.com")));
    assertThatThrownBy(() -> blocking.createRequest(URI.create("https://api.example.com/x"),
        HttpMethod.GET).execute()).hasMessageContaining("hook failed");
    assertThat(closed).containsExactly("unpaid", "paid");
  }

  private static ClientHttpResponse response(HttpStatusCode status, Map<String, String> headers,
      Runnable onClose) {
    return new ClientHttpResponse() {
      private final HttpHeaders h = new HttpHeaders();

      {
        headers.forEach(h::add);
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
        return h;
      }
    };
  }

  // ------------------------------------------------------------ streaming handler by path

  static class StreamingByPath {
    @GetMapping("/events")
    SseEmitter events() {
      return new SseEmitter();
    }
  }

  @Test
  void aPathOfferMatchingAStreamingHandlerFailsStartup() throws Exception {
    TestBinding.Bound bound = TestBinding.bind(
        "x402.routes.events.path", "GET /events",
        "x402.routes.events.accepts[0].network", "test:net",
        "x402.routes.events.accepts[0].pay-to", "addr",
        "x402.routes.events.accepts[0].price", "$1");
    X402Offers offers = OfferResolver.builder(bound.properties()).presence(bound.present())
        .facilitators(List.of("f")).build().resolve();
    Method m = StreamingByPath.class.getDeclaredMethod("events");
    HandlerMethod handler = new HandlerMethod(new StreamingByPath(), m);
    HandlerMethodSource source = new HandlerMethodSource() {
      @Override
      public List<Mapping> mappings() {
        return List.of(new Mapping(handler, Set.of("/events"), Set.of("GET")));
      }

      @Override
      public boolean isStreaming(HandlerMethod hm) {
        return ServletHandlerMethodSource.isStreamingHandler(hm);
      }
    };
    assertThatThrownBy(() -> new OfferRegistry(source, offers, offer -> true))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("\"events\"").hasMessageContaining("stream");
    assertThat(new OfferRegistry(source, offers, offer -> false).warnings())
        .noneMatch(w -> w.contains("stream"));
  }

  // ------------------------------------------------------------ re-sync after an error

  /** Delegates to the test scheme; its capability check throws an Error the first time. */
  static final class FlakyScheme implements SchemeNetworkServer {
    final AtomicInteger checks = new AtomicInteger();
    private final TestServerScheme delegate = new TestServerScheme();

    @Override
    public String scheme() {
      return delegate.scheme();
    }

    @Override
    public String defaultAssetTransferMethod() {
      return delegate.defaultAssetTransferMethod();
    }

    @Override
    public Map<String, PaymentFlow.Config> paymentFlows() {
      return delegate.paymentFlows();
    }

    @Override
    public AssetAmount parsePrice(Price price, String network) {
      return delegate.parsePrice(price, network);
    }

    @Override
    public PaymentRequirements enhancePaymentRequirements(PaymentRequirements requirements,
        SupportedKind supportedKind, List<String> facilitatorExtensions) {
      return delegate.enhancePaymentRequirements(requirements, supportedKind,
          facilitatorExtensions);
    }

    @Override
    public String validateFacilitatorSupport(String network, SupportedKind supportedKind,
        List<String> facilitatorExtensions) {
      if (HookRecorder.MAIN.equals(network) && checks.incrementAndGet() == 1) {
        throw new AssertionError("flaky capability check");
      }
      return null;
    }
  }

  @Test
  void aResyncSurvivesAnError() {
    a.reset(HookRecorder.NET);
    b.reset(HookRecorder.MAIN);
    b.supportedFails(503);
    FlakyScheme flaky = new FlakyScheme();
    new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class))
        .withBean(X402ResourceServerCustomizer.class, () -> (X402ResourceServer s) -> {
          s.register(HookRecorder.NET, new TestServerScheme());
          s.register(HookRecorder.MAIN, flaky);
        })
        .withPropertyValues(
            "x402.facilitators[0].url=" + a.url(),
            "x402.facilitators[1].url=" + b.url(),
            "x402.sync.initial-backoff=50ms",
            "x402.sync.max-backoff=100ms",
            "x402.routes.m.path=GET /m",
            "x402.routes.m.accepts[0].network=test:main",
            "x402.routes.m.accepts[0].pay-to=addr",
            "x402.routes.m.accepts[0].price=$1")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          X402HttpResourceServer http = ctx.getBean(X402HttpResourceServer.class);
          assertThat(http.processHttpRequest(TestAdapter.get("/m").context()))
              .isInstanceOf(HttpProcessResult.RouteUnavailable.class);
          b.supported(HookRecorder.MAIN);
          TestHttp.await(Duration.ofSeconds(5), () -> http.processHttpRequest(
              TestAdapter.get("/m").context()) instanceof HttpProcessResult.PaymentError);
          assertThat(flaky.checks.get()).isGreaterThanOrEqualTo(2);
        });
  }

  // ------------------------------------------------------------ empty spend cap

  @Test
  void anEmptySpendCapWarnsAtStartup(CapturedOutput output) {
    new org.springframework.boot.builder.SpringApplicationBuilder(X402AutoConfiguration.class)
        .web(org.springframework.boot.WebApplicationType.NONE)
        .properties("x402.client.enabled=true", "x402.client.hosts[0]=localhost",
            "x402.client.spend-controls.max-amount-per-payment=")
        .run().close();
    assertThat(output.getOut() + output.getErr())
        .contains("max-amount-per-payment").contains("no USD cap");
  }
}
