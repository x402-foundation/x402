package org.x402.spring.autoconfigure;

import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.Status;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.x402.core.InProcessFacilitatorClient;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedKind;
import org.x402.core.types.SupportedResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.http.FacilitatorAuthProvider;
import org.x402.http.HttpProcessResult;
import org.x402.http.PaywallProvider;
import org.x402.http.RouteConfigurationError;
import org.x402.http.RouteValidationError;
import org.x402.http.X402HttpResourceServer;
import org.x402.spring.FakeFacilitator;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestAdapter;
import org.x402.spring.X402FacilitatorAuthProvider;
import org.x402.spring.X402RouteErrors;
import org.x402.spring.X402ServerLifecycle;
import org.x402.spring.actuate.X402HealthIndicator;
import org.x402.spring.properties.X402Properties;

/** Configuration edge paths of the core auto-configuration. */
class StarterConfigurationEdgeTest {

  private static FakeFacilitator facilitator;

  @BeforeAll
  static void start() {
    facilitator = FakeFacilitator.start(HookRecorder.NET);
  }

  @AfterAll
  static void stop() {
    facilitator.close();
  }

  @BeforeEach
  void reset() {
    facilitator.reset(HookRecorder.NET);
  }

  private static WebApplicationContextRunner runner() {
    return new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class,
            X402WebMvcAutoConfiguration.class))
        .withBean(HookRecorder.class)
        .withPropertyValues(
            "x402.facilitators[0].url=" + facilitator.url(),
            "x402.accounts.net.network=test:net",
            "x402.accounts.net.pay-to=addr_net",
            "x402.routes.r.path=GET /r",
            "x402.routes.r.accepts[0].account=net",
            "x402.routes.r.accepts[0].price=$1");
  }

  /** An in-process facilitator listing {@code exact} on {@code test:net}. */
  static final class InProcess implements InProcessFacilitatorClient {
    @Override
    public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements) {
      return VerifyResponse.valid("p");
    }

    @Override
    public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements) {
      return SettleResponse.success("t", requirements.network(), "p");
    }

    @Override
    public SupportedResponse getSupported() {
      return new SupportedResponse(List.of(new SupportedKind(2, "exact", HookRecorder.NET, null)),
          List.of(), Map.of());
    }

    @Override
    public String identifier() {
      return "in-process";
    }
  }

  @Test
  void anInProcessFacilitatorBeanIsPrependedAsLocal() {
    runner().withBean(InProcess.class).withPropertyValues("x402.local-facilitator=true")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(ctx.getBean(X402ResourceServer.class).facilitatorIdentifiers())
              .containsExactly("local", facilitator.url());
        });
  }

  @Test
  void staticHeadersAndAuthRefsReachTheFacilitator() {
    runner().withPropertyValues(
        "x402.facilitators[0].headers.supported.Authorization=Bearer static")
        .run(ctx -> assertThat(ctx).hasNotFailed());
    assertThat(facilitator.server().countRequestsMatching(getRequestedFor(urlEqualTo(
        "/supported")).withHeader("Authorization", equalTo("Bearer static")).build()).getCount())
        .isEqualTo(1);

    X402FacilitatorAuthProvider provider = () -> new FacilitatorAuthProvider.AuthHeaders(
        null, null, Map.of("Authorization", "Bearer bean"));
    runner().withBean("facilitatorAuth", X402FacilitatorAuthProvider.class, () -> provider)
        .withPropertyValues("x402.facilitators[0].auth-ref=facilitatorAuth")
        .run(ctx -> assertThat(ctx).hasNotFailed());
    assertThat(facilitator.server().countRequestsMatching(getRequestedFor(urlEqualTo(
        "/supported")).withHeader("Authorization", equalTo("Bearer bean")).build()).getCount())
        .isEqualTo(1);

    runner().withPropertyValues("x402.facilitators[0].auth-ref=missing")
        .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause()
            .hasMessageContaining("missing"));
  }

  @Test
  void aFacilitatorWithoutUrlFails() {
    runner().withPropertyValues("x402.facilitators[0].url=", "x402.facilitators[0].identifier=x")
        .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause()
            .hasMessageContaining("url is required"));
  }

  @Test
  void aPriceObjectNeedsAmountAndAsset() {
    runner().withPropertyValues("x402.routes.s.accepts[0].account=net",
            "x402.routes.s.accepts[0].price.amount=5")
        .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause()
            .hasMessageContaining("amount and asset"));
  }

  @Test
  void browsersGetThePaywallProvidersHtmlUnlessThePaywallIsOff() {
    PaywallProvider paywall = (required, config) -> "<html>" + config.appName() + "</html>";
    runner().withBean(PaywallProvider.class, () -> paywall)
        .withPropertyValues("x402.paywall.app-name=Weather Inc")
        .run(ctx -> {
          HttpProcessResult result = ctx.getBean(X402HttpResourceServer.class)
              .processHttpRequest(TestAdapter.get("/r").header("Accept", "text/html")
                  .header("User-Agent", "Mozilla/5.0").context(),
                  ctx.getBean(org.x402.http.PaywallConfig.class));
          assertThat(((HttpProcessResult.PaymentError) result).body())
              .isEqualTo("<html>Weather Inc</html>");
        });
  }

  @Test
  void filterOrderIsConfigurable() {
    runner().withPropertyValues("x402.filter-order=5").run(ctx ->
        assertThat(ctx.getBean("x402ServletFilter", FilterRegistrationBean.class).getOrder())
            .isEqualTo(5));
    runner().run(ctx ->
        assertThat(ctx.getBean("x402ServletFilter", FilterRegistrationBean.class).getOrder())
            .isEqualTo(X402WebMvcAutoConfiguration.DEFAULT_FILTER_ORDER));
  }

  @Test
  void spendControlEdgeShapes() {
    runner().withPropertyValues("x402.client.enabled=true",
            "x402.client.spend-controls.max-amount-per-payment=",
            "x402.client.cardano.mnemonic=abandon",
            "x402.client.cardano.networks[0].network=cardano:preprod",
            "x402.client.cardano.networks[0].blockfrost.project-id=preprodX")
        .run(ctx -> {
          assertThat(ctx.getBean(org.x402.core.client.X402Client.class).spendControls()
              .maxAmountPerPayment()).isNull();
          org.x402.spring.cardano.X402CardanoProperties.ClientCardano cardano =
              org.x402.spring.cardano.X402CardanoProperties.bind(ctx.getEnvironment()).client()
                  .cardano();
          assertThat(cardano.networks().get(0).blockfrost().projectId()).isEqualTo("preprodX");
        });
    runner().withPropertyValues("x402.client.enabled=true",
            "x402.client.spend-controls.allowed-assets[0].network=test:net")
        .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause()
            .hasMessageContaining("allowed-assets[0]"));
    assertThat(new org.x402.spring.cardano.X402CardanoProperties.ClientCardano(null, null)
        .networks()).isEmpty();
  }

  @Test
  void allFacilitatorsDownStartsWithEveryRouteAt503() {
    facilitator.supportedFails(503);
    runner().withPropertyValues("x402.sync.initial-backoff=10s").run(ctx -> {
      assertThat(ctx).hasNotFailed();
      HttpProcessResult result = ctx.getBean(X402HttpResourceServer.class)
          .processHttpRequest(TestAdapter.get("/r").context());
      assertThat(result).isInstanceOf(HttpProcessResult.RouteUnavailable.class);
      assertThat(((HttpProcessResult.RouteUnavailable) result).retryable()).isTrue();
      Health health = ctx.getBean(X402HealthIndicator.class).health();
      assertThat(health.getStatus()).isEqualTo(Status.OUT_OF_SERVICE);
      assertThat(health.getDetails().toString()).contains("DOWN");
      assertThat(ctx.getBean(X402ServerLifecycle.class).status())
          .isEqualTo(X402ServerLifecycle.Status.AWAITING_FACILITATORS);
    });
  }

  @Test
  void healthBeforeAnySyncReportsNotSynced() {
    runner().withPropertyValues("x402.routes.r.accepts[0].account=net").run(ctx -> {
      X402ServerLifecycle idle = new X402ServerLifecycle(
          ctx.getBean(X402HttpResourceServer.class), false,
          ctx.getBean(X402Properties.class).sync());
      assertThat(idle.isRunning()).isFalse();
      assertThat(idle.getPhase()).isEqualTo(X402ServerLifecycle.PHASE);
      assertThat(idle.synced()).isFalse();
      idle.start();
      assertThat(idle.isRunning()).isTrue();
      idle.stop();
      assertThat(idle.isRunning()).isFalse();
    });
  }

  @Test
  void routeErrorsWithoutARouteOrAlreadyNamedStayAsTheyAre() {
    RouteValidationError global = new RouteValidationError(null, "exact", "n",
        RouteValidationError.Reason.FACILITATOR_CAPABILITY, "global", null, null, false);
    RouteValidationError named = new RouteValidationError("r", "exact", "n",
        RouteValidationError.Reason.MISSING_SCHEME, "offer \"r\": x", 0, null, false);
    RouteValidationError offerLevel = new RouteValidationError("r", "exact", "n",
        RouteValidationError.Reason.AMBIGUOUS_OPTIONS, "ambiguous", null, null, false);
    RouteConfigurationError out = X402RouteErrors.withOfferNames(
        new RouteConfigurationError(List.of(global, named, offerLevel)));
    assertThat(out.errors().get(0).message()).isEqualTo("global");
    assertThat(out.errors().get(1).message()).isEqualTo("offer \"r\": x");
    assertThat(out.errors().get(2).message()).isEqualTo("offer \"r\": ambiguous");
  }
}
