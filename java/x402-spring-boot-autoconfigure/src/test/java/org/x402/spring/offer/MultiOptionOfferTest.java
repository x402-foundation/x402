package org.x402.spring.offer;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.http.HttpProcessResult;
import org.x402.http.HttpTransportContext;
import org.x402.http.ProcessSettleResult;
import org.x402.http.RouteConfigurationError;
import org.x402.http.X402Headers;
import org.x402.http.X402HttpResourceServer;
import org.x402.spring.FakeFacilitator;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestAdapter;
import org.x402.spring.autoconfigure.X402AutoConfiguration;

/** Through the starter: several options, several facilitators. */
class MultiOptionOfferTest {

  private static FakeFacilitator owner;
  private static FakeFacilitator backup;

  @BeforeAll
  static void start() {
    owner = FakeFacilitator.start(HookRecorder.NET, HookRecorder.MAIN);
    backup = FakeFacilitator.start(HookRecorder.NET, HookRecorder.MAIN);
  }

  @AfterAll
  static void stop() {
    owner.close();
    backup.close();
  }

  @BeforeEach
  void reset() {
    owner.reset(HookRecorder.NET, HookRecorder.MAIN);
    backup.reset(HookRecorder.NET, HookRecorder.MAIN);
  }

  private static WebApplicationContextRunner runner() {
    return new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class))
        .withBean(HookRecorder.class)
        .withPropertyValues(
            "x402.facilitators[0].url=" + owner.url(),
            "x402.facilitators[0].identifier=owner",
            "x402.facilitators[1].url=" + backup.url(),
            "x402.facilitators[1].identifier=backup",
            "x402.accounts.net.network=test:net",
            "x402.accounts.net.pay-to=addr_net",
            "x402.accounts.main.network=test:main",
            "x402.accounts.main.pay-to=addr_main",
            "x402.routes.report.path=GET /report",
            "x402.routes.report.accepts[0].account=net",
            "x402.routes.report.accepts[0].price=$0.50",
            "x402.routes.report.accepts[1].account=net",
            "x402.routes.report.accepts[1].price.amount=1500000",
            "x402.routes.report.accepts[1].price.asset=lovelace",
            "x402.routes.report.accepts[2].account=main",
            "x402.routes.report.accepts[2].price=$0.50",
            "x402.routes.report.accepts[3].account=net",
            "x402.routes.report.accepts[3].price=$0.75",
            "x402.routes.report.accepts[3].extra.tier=gold");
  }

  @Test
  void fourOptionsAreAdvertisedInYamlOrder() {
    runner().run(ctx -> {
      assertThat(ctx).hasNotFailed();
      X402HttpResourceServer http = ctx.getBean(X402HttpResourceServer.class);
      PaymentRequired required = TestAdapter.paymentRequired(
          http.processHttpRequest(TestAdapter.get("/report").context()));
      List<String> summary = new ArrayList<>();
      required.accepts().forEach(r -> summary.add(r.network() + " " + r.asset() + " "
          + r.amount()));
      assertThat(summary).containsExactly(
          "test:net USDM 500000",
          "test:net lovelace 1500000",
          "test:main USDM 500000",
          "test:net USDM 750000");
      assertThat(required.accepts().get(3).extra()).containsEntry("tier", "gold");
    });
  }

  @Test
  void aPaymentForOptionThreeMatchesOptionThreeEvenWithAdditiveClientExtra() {
    runner().run(ctx -> {
      X402HttpResourceServer http = ctx.getBean(X402HttpResourceServer.class);
      PaymentRequired required = TestAdapter.paymentRequired(
          http.processHttpRequest(TestAdapter.get("/report").context()));
      PaymentRequirements third = required.accepts().get(2);
      PaymentRequirements withClientExtra = third.withExtra("clientNote", "added");
      TestAdapter paid = TestAdapter.get("/report").header(X402Headers.PAYMENT_SIGNATURE,
          TestAdapter.signature(required, withClientExtra, null));

      HttpProcessResult result = http.processHttpRequest(paid.context());

      assertThat(result).isInstanceOf(HttpProcessResult.PaymentVerified.class);
      HttpProcessResult.PaymentVerified verified = (HttpProcessResult.PaymentVerified) result;
      assertThat(verified.paymentRequirements()).isEqualTo(third);
      ProcessSettleResult settled = http.processSettlement(verified,
          new HttpTransportContext(paid.context(), new byte[0], Map.of()));
      assertThat(settled).isInstanceOf(ProcessSettleResult.Success.class);
      assertThat(owner.bodies("settle")).hasSize(1);
      assertThat(owner.bodies("settle").get(0)).contains("test:main");
    });
  }

  @Test
  void anUnsupportedOptionFailsStartupNamingOfferAndIndex() {
    runner().withPropertyValues(
        "x402.routes.report.accepts[4].network=test:net",
        "x402.routes.report.accepts[4].pay-to=addr",
        "x402.routes.report.accepts[4].scheme=nope",
        "x402.routes.report.accepts[4].price=$9")
        .run(ctx -> {
          assertThat(ctx).hasFailed();
          List<Throwable> chain = new ArrayList<>();
          for (Throwable t = ctx.getStartupFailure(); t != null; t = t.getCause()) {
            chain.add(t);
          }
          assertThat(chain).anyMatch(t -> t instanceof RouteConfigurationError
              && t.getMessage().contains("offer \"report\" accepts[4]"));
        });
  }

  @Test
  void firstFacilitatorOwnsTheKindAndPinnedOptionsUseTheirFacilitator() {
    runner().withPropertyValues(
        "x402.routes.pinned.path=GET /pinned",
        "x402.routes.pinned.accepts[0].account=net",
        "x402.routes.pinned.accepts[0].price=$1",
        "x402.routes.pinned.accepts[0].facilitator=backup")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          X402HttpResourceServer http = ctx.getBean(X402HttpResourceServer.class);
          payAndSettle(http, "/report", 0);
          assertThat(owner.count("verify")).isEqualTo(1);
          assertThat(owner.count("settle")).isEqualTo(1);
          assertThat(backup.count("verify")).isZero();

          payAndSettle(http, "/pinned", 0);
          assertThat(backup.count("verify")).isEqualTo(1);
          assertThat(backup.count("settle")).isEqualTo(1);
          assertThat(owner.count("verify")).isEqualTo(1);
        });
  }

  @Test
  void failoverVerifiesOnTheBackupWhenTheOwnerAnswers503WithoutIsValidThenSettlesThere() {
    runner().withPropertyValues("x402.routes.report.failover=true").run(ctx -> {
      assertThat(ctx).hasNotFailed();
      owner.verifyAnswers(503, "{\"error\":\"overloaded\"}");
      X402HttpResourceServer http = ctx.getBean(X402HttpResourceServer.class);

      HttpProcessResult.PaymentVerified verified = payAndSettle(http, "/report", 0);

      assertThat(verified.verifiedBy()).isEqualTo("backup");
      assertThat(owner.count("verify")).isEqualTo(1);
      assertThat(backup.count("verify")).isEqualTo(1);
      assertThat(backup.count("settle")).isEqualTo(1);
      assertThat(owner.count("settle")).isZero();
    });
  }

  private static HttpProcessResult.PaymentVerified payAndSettle(X402HttpResourceServer http,
      String path, int index) {
    PaymentRequired required = TestAdapter.paymentRequired(
        http.processHttpRequest(TestAdapter.get(path).context()));
    TestAdapter paid = TestAdapter.get(path).header(X402Headers.PAYMENT_SIGNATURE,
        TestAdapter.signature(required, required.accepts().get(index), null));
    HttpProcessResult result = http.processHttpRequest(paid.context());
    assertThat(result).isInstanceOf(HttpProcessResult.PaymentVerified.class);
    HttpProcessResult.PaymentVerified verified = (HttpProcessResult.PaymentVerified) result;
    assertThat(http.processSettlement(verified,
        new HttpTransportContext(paid.context(), new byte[0], Map.of())))
        .isInstanceOf(ProcessSettleResult.Success.class);
    return verified;
  }
}
