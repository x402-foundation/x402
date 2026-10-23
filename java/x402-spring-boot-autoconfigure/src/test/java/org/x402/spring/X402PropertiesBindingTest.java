package org.x402.spring;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.SystemEnvironmentPropertySource;
import org.x402.core.FacilitatorClient;
import org.x402.core.client.SpendControls;
import org.x402.core.client.X402Client;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.Money;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.http.PaymentOption;
import org.x402.http.RouteConfigurationError;
import org.x402.spring.autoconfigure.X402AutoConfiguration;
import org.x402.spring.offer.X402OptionContributor;
import org.x402.spring.offer.X402Offers;
import org.x402.spring.properties.X402Properties;

/** {@code x402.*} binding: the documented configuration contract. */
class X402PropertiesBindingTest {

  private static FakeFacilitator facilitator;
  private static FakeFacilitator second;

  @BeforeAll
  static void start() {
    facilitator = FakeFacilitator.start(HookRecorder.NET, HookRecorder.MAIN);
    second = FakeFacilitator.start(HookRecorder.NET, HookRecorder.MAIN);
  }

  @AfterAll
  static void stop() {
    facilitator.close();
    second.close();
  }

  private static WebApplicationContextRunner runner() {
    return new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class))
        .withBean(HookRecorder.class)
        .withPropertyValues(
            "x402.facilitators[0].url=" + facilitator.url(),
            "x402.accounts.net.network=test:net",
            "x402.accounts.net.pay-to=addr_net",
            "x402.accounts.main.network=test:main",
            "x402.accounts.main.pay-to=addr_main");
  }

  private static PaymentOption option(org.springframework.context.ApplicationContext ctx,
      String offer, int index) {
    return ctx.getBean(X402Offers.class).offer(offer).route().accepts().get(index);
  }

  @Test
  void minimalConfigBinds() {
    runner().withPropertyValues(
        "x402.routes.weather.accepts[0].account=net",
        "x402.routes.weather.accepts[0].price=$0.01")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          X402Properties properties = ctx.getBean(X402Properties.class);
          assertThat(properties.enabled()).isTrue();
          assertThat(properties.routes()).containsOnlyKeys("weather");
          assertThat(option(ctx, "weather", 0).network()).isEqualTo("test:net");
          assertThat(option(ctx, "weather", 0).payTo()).isEqualTo("addr_net");
          assertThat(option(ctx, "weather", 0).price()).isEqualTo(new Money("$0.01"));
        });
  }

  @Test
  void priceFormsBind() {
    runner().withPropertyValues(
        "x402.routes.r.accepts[0].account=net",
        "x402.routes.r.accepts[0].price=$0.50",
        "x402.routes.r.accepts[1].account=net",
        "x402.routes.r.accepts[1].price=0.50 USDM",
        "x402.routes.r.accepts[2].account=main",
        "x402.routes.r.accepts[2].price.amount=1500000",
        "x402.routes.r.accepts[2].price.asset=lovelace",
        "x402.routes.r.accepts[2].price.extra.note=atomic")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(option(ctx, "r", 0).price()).isEqualTo(new Money("$0.50"));
          assertThat(option(ctx, "r", 1).price()).isEqualTo(new Money("0.50 USDM"));
          AssetAmount atomic = (AssetAmount) option(ctx, "r", 2).price();
          assertThat(atomic.amount()).isEqualTo("1500000");
          assertThat(atomic.asset()).isEqualTo("lovelace");
          assertThat(atomic.extra()).containsEntry("note", "atomic");
        });
  }

  @Test
  void priceExtraMergesBelowAccountAndOption() {
    List<Map<String, Object>> seen = new CopyOnWriteArrayList<>();
    X402OptionContributor spy = option -> seen.add(option.extra());
    runner().withBean(X402OptionContributor.class, () -> spy).withPropertyValues(
        "x402.accounts.net.extra.b=account",
        "x402.accounts.net.extra.c=account",
        "x402.routes.r.accepts[0].account=net",
        "x402.routes.r.accepts[0].price.amount=10",
        "x402.routes.r.accepts[0].price.asset=USDM",
        "x402.routes.r.accepts[0].price.extra.a=price",
        "x402.routes.r.accepts[0].price.extra.b=price",
        "x402.routes.r.accepts[0].price.extra.c=price",
        "x402.routes.r.accepts[0].extra.c=option")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(seen).hasSize(1);
          assertThat(seen.get(0)).containsEntry("a", "price").containsEntry("b", "account")
              .containsEntry("c", "option");
          assertThat(option(ctx, "r", 0).extra()).containsEntry("b", "account")
              .containsEntry("c", "option");
        });
  }

  @Test
  void defaultsExtraIsAStartupError() {
    runner().withPropertyValues(
        "x402.defaults.extra.assetTransferMethod=masumi",
        "x402.routes.r.accepts[0].account=net",
        "x402.routes.r.accepts[0].price=$1")
        .run(ctx -> assertThat(ctx).hasFailed().getFailure()
            .rootCause().hasMessageContaining("x402.defaults.extra"));
  }

  @Test
  void placeholderPriceIsOverriddenFromTheEnvironment() {
    runner()
        .withInitializer(c -> c.getEnvironment().getPropertySources().addFirst(
            new SystemEnvironmentPropertySource("test-systemEnvironment", Map.of("REPORT_PRICE", "$0.70"))))
        .withPropertyValues(
            "x402.routes.report.accepts[0].account=net",
            "x402.routes.report.accepts[0].price=${REPORT_PRICE:$0.50}")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(option(ctx, "report", 0).price()).isEqualTo(new Money("$0.70"));
        });
    runner().withPropertyValues(
            "x402.routes.report.accepts[0].account=net",
            "x402.routes.report.accepts[0].price=${REPORT_PRICE_UNSET:$0.50}")
        .run(ctx -> assertThat(option(ctx, "report", 0).price()).isEqualTo(new Money("$0.50")));
  }

  @Test
  void envVarOnOneListElementReplacesTheListAndFailsPointingToPlaceholders() {
    runner()
        .withInitializer(c -> {
          c.getEnvironment().getPropertySources().addLast(new MapPropertySource("yaml", Map.of(
              "x402.routes.report.accepts[0].account", "net",
              "x402.routes.report.accepts[0].price", "$0.50")));
          c.getEnvironment().getPropertySources().addFirst(new SystemEnvironmentPropertySource(
              "test-systemEnvironment", Map.of("X402_ROUTES_REPORT_ACCEPTS_0_PRICE", "$0.70")));
        })
        .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause()
            .hasMessageContaining("offer \"report\" accepts[0]")
            .hasMessageContaining("placeholder"));
  }

  @Test
  void priceAndPriceRefIsAStartupError() {
    runner().withPropertyValues(
        "x402.routes.r.accepts[0].account=net",
        "x402.routes.r.accepts[0].price=$1",
        "x402.routes.r.accepts[0].price-ref=pricer")
        .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause()
            .hasMessageContaining("price-ref"));
  }

  @Test
  void adaSugarIsAStartupError() {
    runner().withPropertyValues(
        "x402.routes.r.accepts[0].account=net",
        "x402.routes.r.accepts[0].price=1.5 ADA")
        .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause()
            .hasMessageContaining("1.5 ADA"));
  }

  @Test
  void invalidMoneyIsAStartupError() {
    runner().withPropertyValues(
        "x402.routes.r.accepts[0].account=net",
        "x402.routes.r.accepts[0].price=cheap")
        .run(ctx -> assertThat(ctx).hasFailed().getFailure()
            .hasStackTraceContaining("Invalid money format"));
  }

  @Test
  void extraIsAMap() {
    runner().withPropertyValues(
        "x402.routes.r.accepts[0].account=net",
        "x402.routes.r.accepts[0].price=$1",
        "x402.routes.r.accepts[0].extra.assetTransferMethod=prepaid",
        "x402.routes.r.accepts[0].extra.nested.key=value")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          Map<String, Object> extra = option(ctx, "r", 0).extra();
          assertThat(extra).containsEntry("assetTransferMethod", "prepaid");
          assertThat(extra.get("nested")).isEqualTo(Map.of("key", "value"));
        });
  }

  @Test
  void defaultsMergeUnderAccountsAndOptions() {
    runner().withPropertyValues(
        "x402.defaults.scheme=exact",
        "x402.defaults.max-timeout-seconds=90",
        "x402.defaults.failover=true",
        "x402.accounts.main.max-timeout-seconds=30",
        "x402.routes.r.accepts[0].account=net",
        "x402.routes.r.accepts[0].price=$1",
        "x402.routes.r.accepts[1].account=main",
        "x402.routes.r.accepts[1].price=$1")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(option(ctx, "r", 0).maxTimeoutSeconds()).isEqualTo(90);
          assertThat(option(ctx, "r", 1).maxTimeoutSeconds()).isEqualTo(30);
          assertThat(option(ctx, "r", 0).scheme()).isEqualTo("exact");
          assertThat(ctx.getBean(X402Offers.class).offer("r").route().failover()).isTrue();
        });
  }

  @Test
  void facilitatorsAbsentGiveTheDefaultEntry() {
    new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class))
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(ctx.getBean(X402ResourceServer.class).facilitatorIdentifiers())
              .containsExactly("https://x402.org/facilitator");
          assertThat(ctx.getBean(X402Properties.class).facilitators()).isEmpty();
        });
  }

  @Test
  void facilitatorOrderIsKeptAndIdentifiersDefaultToTheUrlWithoutTrailingSlash() {
    new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitators[0].url=" + second.url() + "/",
            "x402.facilitators[1].url=" + facilitator.url(),
            "x402.facilitators[1].identifier=team/",
            "x402.facilitators[1].timeout=30s",
            "x402.facilitators[1].verify-timeout=5s",
            "x402.facilitators[1].headers.verify.Authorization=Bearer t")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(ctx.getBean(X402ResourceServer.class).facilitatorIdentifiers())
              .containsExactly(second.url(), "team");
          X402Properties.Facilitator f = ctx.getBean(X402Properties.class).facilitators().get(1);
          assertThat(f.timeout()).isEqualTo(Duration.ofSeconds(30));
          assertThat(f.verifyTimeout()).isEqualTo(Duration.ofSeconds(5));
          assertThat(f.headers().verify()).containsEntry("Authorization", "Bearer t");
          X402Properties.Facilitator first =
              ctx.getBean(X402Properties.class).facilitators().get(0);
          assertThat(first.timeout()).isEqualTo(Duration.ofSeconds(90));
          assertThat(first.verifyTimeout()).isEqualTo(Duration.ofSeconds(15));
          FacilitatorClient client = ctx.getBean(X402ResourceServer.class).facilitator("team");
          assertThat(client.verifyTimeout()).isEqualTo(Duration.ofSeconds(5));
        });
  }

  @Test
  void duplicateEffectiveIdentifiersFail() {
    new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitators[0].url=https://a",
            "x402.facilitators[1].url=https://a/")
        .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause()
            .hasMessageContaining("https://a").hasMessageContaining("duplicate"));
    new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitators[0].url=https://a",
            "x402.facilitators[1].url=https://b",
            "x402.facilitators[1].identifier=https://a")
        .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause()
            .hasMessageContaining("https://a").hasMessageContaining("duplicate"));
  }

  @Test
  void userEntryNamedLocalFails() {
    new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitators[0].url=https://a",
            "x402.facilitators[0].identifier=local")
        .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause()
            .hasMessageContaining("\"local\"").hasMessageContaining("reserved"));
  }

  @Test
  void pinsMatchEffectiveIdentifiersOnly() {
    WebApplicationContextRunner two = new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class))
        .withBean(HookRecorder.class)
        .withPropertyValues(
            "x402.facilitators[0].url=" + facilitator.url(),
            "x402.facilitators[0].identifier=team/",
            "x402.facilitators[1].url=" + second.url(),
            "x402.accounts.net.network=test:net",
            "x402.accounts.net.pay-to=addr_net");
    two.withPropertyValues(
        "x402.routes.r.accepts[0].account=net",
        "x402.routes.r.accepts[0].price=$1",
        "x402.routes.r.accepts[0].facilitator=team",
        "x402.routes.r.accepts[1].account=net",
        "x402.routes.r.accepts[1].price=$2",
        "x402.routes.r.accepts[1].facilitator=team/",
        "x402.routes.r.accepts[2].account=net",
        "x402.routes.r.accepts[2].price=$3",
        "x402.routes.r.accepts[2].facilitator=" + second.url() + "/")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(option(ctx, "r", 0).facilitator()).isEqualTo("team");
          assertThat(option(ctx, "r", 1).facilitator()).isEqualTo("team");
          assertThat(option(ctx, "r", 2).facilitator()).isEqualTo(second.url());
        });
    two.withPropertyValues(
        "x402.routes.r.accepts[0].account=net",
        "x402.routes.r.accepts[0].price=$1",
        "x402.routes.r.accepts[0].facilitator=" + facilitator.url())
        .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause()
            .hasMessageContaining("unknown facilitator").hasMessageContaining("team"));
  }

  @Test
  void syncAndLocalFacilitatorBind() {
    FacilitatorClient local = new FacilitatorClient() {
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
        return new SupportedResponse(List.of(), List.of(), Map.of());
      }

      @Override
      public String identifier() {
        return "local";
      }
    };
    runner().withBean("x402LocalFacilitatorClient", FacilitatorClient.class, () -> local)
        .withPropertyValues(
            "x402.sync.startup-timeout=3s",
            "x402.local-facilitator=true")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          X402Properties properties = ctx.getBean(X402Properties.class);
          assertThat(properties.sync().startupTimeout()).isEqualTo(Duration.ofSeconds(3));
          assertThat(properties.localFacilitator()).isTrue();
          assertThat(ctx.getBean(X402ResourceServer.class).facilitatorIdentifiers())
              .containsExactly("local", facilitator.url());
        });
    runner().withPropertyValues("x402.local-facilitator=true")
        .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause()
            .hasMessageContaining("x402.facilitator-server"));
    runner().run(ctx -> assertThat(ctx.getBean(X402Properties.class).sync().startupTimeout())
        .isEqualTo(Duration.ofSeconds(10)));
  }

  @Test
  void pinPrecedenceAndFailoverPrecedence() {
    runner().withPropertyValues(
        "x402.facilitators[1].url=" + second.url(),
        "x402.facilitators[1].identifier=backup",
        "x402.defaults.facilitator=backup",
        "x402.defaults.failover=true",
        "x402.accounts.main.facilitator=" + facilitator.url(),
        "x402.routes.a.accepts[0].account=net",
        "x402.routes.a.accepts[0].price=$1",
        "x402.routes.a.accepts[1].account=main",
        "x402.routes.a.accepts[1].price=$1",
        "x402.routes.a.accepts[2].account=main",
        "x402.routes.a.accepts[2].price=$2",
        "x402.routes.a.accepts[2].facilitator=backup",
        "x402.routes.b.failover=false",
        "x402.routes.b.accepts[0].account=net",
        "x402.routes.b.accepts[0].price=$1")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(option(ctx, "a", 0).facilitator()).isEqualTo("backup");
          assertThat(option(ctx, "a", 1).facilitator()).isEqualTo(facilitator.url());
          assertThat(option(ctx, "a", 2).facilitator()).isEqualTo("backup");
          X402Offers offers = ctx.getBean(X402Offers.class);
          assertThat(offers.offer("a").route().failover()).isTrue();
          assertThat(offers.offer("b").route().failover()).isFalse();
          assertThat(ctx.getBean(X402Properties.class).routes().get("a").failover()).isNull();
          assertThat(ctx.getBean(X402Properties.class).routes().get("b").failover()).isFalse();
        });
  }

  @Test
  void spendControlShapesBind() {
    runner().withPropertyValues("x402.client.enabled=true")
        .run(ctx -> assertThat(ctx.getBean(X402Client.class).spendControls())
            .isEqualTo(SpendControls.defaults()));
    runner().withPropertyValues("x402.client.enabled=true",
            "x402.client.spend-controls.enabled=false")
        .run(ctx -> assertThat(ctx.getBean(X402Client.class).spendControls())
            .isEqualTo(SpendControls.disabled()));
    runner().withPropertyValues("x402.client.enabled=true",
            "x402.client.spend-controls.max-amount-per-payment=$2",
            "x402.client.spend-controls.allow-any-asset=true",
            "x402.client.spend-controls.allowed-assets[0].network=test:net",
            "x402.client.spend-controls.allowed-assets[0].asset=lovelace",
            "x402.client.spend-controls.allowed-assets[0].max-amount-per-payment=5000000",
            "x402.client.prefer.networks[0]=test:main",
            "x402.client.prefer.schemes[0]=exact",
            "x402.client.hosts[0]=api.example.com",
            "x402.client.max-replay-body=2KB")
        .run(ctx -> {
          SpendControls controls = ctx.getBean(X402Client.class).spendControls();
          assertThat(controls.enabled()).isTrue();
          assertThat(controls.maxAmountPerPayment()).isEqualTo("$2");
          assertThat(controls.allowAnyAsset()).isTrue();
          assertThat(controls.allowedAssets()).containsExactly(
              new SpendControls.AllowedAsset("test:net", "lovelace", "5000000"));
          X402Properties.Client client = ctx.getBean(X402Properties.class).client();
          assertThat(client.hosts()).containsExactly("api.example.com");
          assertThat(client.prefer().networks()).containsExactly("test:main");
          assertThat(client.maxReplayBody().toBytes()).isEqualTo(2048);
          assertThat(client.instrumentBeans()).isTrue();
        });
    runner().run(ctx -> assertThat(ctx).doesNotHaveBean(X402Client.class));
  }

  @Test
  void disabledStarterCreatesNothing() {
    runner().withPropertyValues("x402.enabled=false", "x402.client.enabled=true",
            "x402.routes.r.accepts[0].account=nope")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(ctx).doesNotHaveBean(X402ResourceServer.class);
          assertThat(ctx).doesNotHaveBean(X402Client.class);
        });
  }

  @Test
  void routeConfigurationErrorsNameTheOfferAndOption() {
    runner().withPropertyValues(
        "x402.routes.r.accepts[0].account=net",
        "x402.routes.r.accepts[0].price=$1",
        "x402.routes.r.accepts[0].extra.assetTransferMethod=nope")
        .run(ctx -> {
          assertThat(ctx).hasFailed();
          Throwable root = ctx.getStartupFailure();
          List<Throwable> chain = new ArrayList<>();
          for (Throwable t = root; t != null; t = t.getCause()) {
            chain.add(t);
          }
          assertThat(chain).anyMatch(t -> t instanceof RouteConfigurationError
              && t.getMessage().contains("offer \"r\" accepts[0]"));
        });
  }
}
