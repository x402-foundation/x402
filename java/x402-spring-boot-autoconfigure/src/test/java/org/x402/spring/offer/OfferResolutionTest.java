package org.x402.spring.offer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.Money;
import org.x402.http.DynamicPayTo;
import org.x402.http.HttpFacilitatorClient;
import org.x402.http.PaymentOption;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestBinding;
import org.x402.spring.TestServerScheme;
import org.x402.spring.X402ConfigurationException;
import org.x402.spring.X402DynamicPayTo;
import org.x402.spring.X402DynamicPrice;

/** Offers + accounts + defaults → core routes. */
class OfferResolutionTest {

  private static final String F = "https://facilitator.example";

  private static final String[] ACCOUNTS = {
    "x402.accounts.preprod.network", "test:net",
    "x402.accounts.preprod.pay-to", "addr_test_seller",
    "x402.accounts.mainnet.network", "test:main",
    "x402.accounts.mainnet.pay-to", "addr_main_seller",
  };

  private static String[] with(String... kv) {
    String[] all = new String[ACCOUNTS.length + kv.length];
    System.arraycopy(ACCOUNTS, 0, all, 0, ACCOUNTS.length);
    System.arraycopy(kv, 0, all, ACCOUNTS.length, kv.length);
    return all;
  }

  private static OfferResolver.Builder resolver(String... kv) {
    TestBinding.Bound bound = TestBinding.bind(kv);
    return OfferResolver.builder(bound.properties()).presence(bound.present())
        .facilitators(List.of(F, "backup"));
  }

  private static X402Offers resolve(String... kv) {
    return resolver(kv).build().resolve();
  }

  private static List<PaymentOption> options(X402Offers offers, String name) {
    return offers.offer(name).route().accepts();
  }

  private static X402ResourceServer serverWithScheme() {
    X402ResourceServer server = X402ResourceServer.builder()
        .facilitator(HttpFacilitatorClient.builder().url(F).build()).build();
    new HookRecorder().customize(server);
    return server;
  }

  @Test
  void twoAccountsYieldTwoOptionsInOrderWithTheirNetworkAndPayTo() {
    X402Offers offers = resolve(with(
        "x402.routes.report.accepts[0].account", "preprod",
        "x402.routes.report.accepts[0].price", "$0.50",
        "x402.routes.report.accepts[1].account", "mainnet",
        "x402.routes.report.accepts[1].price", "$0.60"));

    List<PaymentOption> options = options(offers, "report");
    assertThat(options).hasSize(2);
    assertThat(options.get(0).network()).isEqualTo("test:net");
    assertThat(options.get(0).payTo()).isEqualTo("addr_test_seller");
    assertThat(options.get(0).price()).isEqualTo(new Money("$0.50"));
    assertThat(options.get(1).network()).isEqualTo("test:main");
    assertThat(options.get(1).payTo()).isEqualTo("addr_main_seller");
    assertThat(options.get(1).price()).isEqualTo(new Money("$0.60"));
  }

  @Test
  void priceFormsAllBind() {
    X402Offers offers = resolve(with(
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].price", "$0.50",
        "x402.routes.r.accepts[1].account", "preprod",
        "x402.routes.r.accepts[1].price", "0.50 USDM",
        "x402.routes.r.accepts[2].account", "preprod",
        "x402.routes.r.accepts[2].price.amount", "1500000",
        "x402.routes.r.accepts[2].price.asset", "lovelace"));

    List<PaymentOption> options = options(offers, "r");
    assertThat(options.get(0).price()).isEqualTo(new Money("$0.50"));
    assertThat(options.get(1).price()).isEqualTo(new Money("0.50 USDM"));
    assertThat(options.get(2).price()).isInstanceOf(AssetAmount.class);
    AssetAmount ada = (AssetAmount) options.get(2).price();
    assertThat(ada.amount()).isEqualTo("1500000");
    assertThat(ada.asset()).isEqualTo("lovelace");
  }

  @Test
  void priceAndPriceRefTogetherFail() {
    assertThatThrownBy(() -> resolve(with(
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].price", "$0.50",
        "x402.routes.r.accepts[0].price-ref", "pricer")))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("offer \"r\" accepts[0]")
        .hasMessageContaining("price-ref");
  }

  @Test
  void adaTickerFailsAsInTs() {
    assertThatThrownBy(() -> resolver(with(
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].price", "1.5 ADA"))
        .server(serverWithScheme()).build().resolve())
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("offer \"r\" accepts[0]")
        .hasMessageContaining("1.5 ADA");
  }

  @Test
  void missingPriceFails() {
    assertThatThrownBy(() -> resolve(with("x402.routes.r.accepts[0].account", "preprod")))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("offer \"r\" accepts[0]")
        .hasMessageContaining("price");
  }

  @Test
  void precedenceIsOptionThenAccountThenDefaultsThenBuiltIn() {
    X402Offers offers = resolve(with(
        "x402.accounts.custom.network", "test:net",
        "x402.accounts.custom.pay-to", "addr_custom",
        "x402.accounts.custom.scheme", "upto",
        "x402.accounts.custom.max-timeout-seconds", "120",
        "x402.accounts.custom.extra.a", "account",
        "x402.accounts.custom.extra.b", "account",
        "x402.defaults.max-timeout-seconds", "200",
        "x402.routes.r.accepts[0].account", "custom",
        "x402.routes.r.accepts[0].price", "$1",
        "x402.routes.r.accepts[0].scheme", "exact",
        "x402.routes.r.accepts[0].extra.b", "option",
        "x402.routes.r.accepts[1].account", "custom",
        "x402.routes.r.accepts[1].price", "$2",
        "x402.routes.r.accepts[2].account", "preprod",
        "x402.routes.r.accepts[2].price", "$3"));

    List<PaymentOption> options = options(offers, "r");
    assertThat(options.get(0).scheme()).isEqualTo("exact");
    assertThat(options.get(0).maxTimeoutSeconds()).isEqualTo(120);
    assertThat(options.get(0).extra()).containsEntry("a", "account").containsEntry("b", "option");
    assertThat(options.get(1).scheme()).isEqualTo("upto");
    assertThat(options.get(1).extra()).containsEntry("b", "account");
    assertThat(options.get(2).scheme()).isEqualTo("exact");
    assertThat(options.get(2).maxTimeoutSeconds()).isEqualTo(200);

    X402Offers builtIn = resolve(with(
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].price", "$3"));
    assertThat(options(builtIn, "r").get(0).effectiveMaxTimeoutSeconds()).isEqualTo(300);
    assertThat(options(builtIn, "r").get(0).scheme()).isEqualTo("exact");
  }

  @Test
  void inlineOptionWithoutAccountWorks() {
    X402Offers offers = resolve(
        "x402.routes.r.accepts[0].network", "test:main",
        "x402.routes.r.accepts[0].pay-to", "addr_partner",
        "x402.routes.r.accepts[0].price", "$0.60");

    PaymentOption option = options(offers, "r").get(0);
    assertThat(option.network()).isEqualTo("test:main");
    assertThat(option.payTo()).isEqualTo("addr_partner");
  }

  @Test
  void unknownAccountFailsListingKnownOnes() {
    assertThatThrownBy(() -> resolve(with(
        "x402.routes.r.accepts[0].account", "nope",
        "x402.routes.r.accepts[0].price", "$1")))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("unknown account \"nope\"")
        .hasMessageContaining("preprod")
        .hasMessageContaining("mainnet");
  }

  @Test
  void offerLevelFieldsThatSpanNetworksFailWithAHint() {
    Map<String, String> fields = Map.of(
        "network", "test:net",
        "pay-to", "addr",
        "pay-to-ref", "bean",
        "extra.k", "v",
        "facilitator", F,
        "scheme", "exact",
        "max-timeout-seconds", "60");
    fields.forEach((field, value) -> assertThatThrownBy(() -> resolve(with(
        "x402.routes.r." + field, value,
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].price", "$1")))
        .as(field)
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("offer \"r\"")
        .hasMessageContaining("\"" + field.replace(".k", "") + "\"")
        .hasMessageContaining("account"));
  }

  @Test
  void offerLevelPriceOrAccountsFailWithAnAcceptsHint() {
    for (String field : List.of("price", "price-ref", "accounts")) {
      assertThatThrownBy(() -> resolve(with(
          "x402.routes.r." + field, "x",
          "x402.routes.r.accepts[0].account", "preprod",
          "x402.routes.r.accepts[0].price", "$1")))
          .as(field)
          .isInstanceOf(X402ConfigurationException.class)
          .hasMessageContaining("offer \"r\"")
          .hasMessageContaining("\"" + field + "\"")
          .hasMessageContaining("accepts");
    }
  }

  @Test
  void accountAndNetworkTogetherFail() {
    assertThatThrownBy(() -> resolve(with(
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].network", "test:main",
        "x402.routes.r.accepts[0].price", "$1")))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("offer \"r\" accepts[0]")
        .hasMessageContaining("account")
        .hasMessageContaining("network");
  }

  @Test
  void neitherAccountNorNetworkFails() {
    assertThatThrownBy(() -> resolve(with("x402.routes.r.accepts[0].price", "$1")))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("offer \"r\" accepts[0]")
        .hasMessageContaining("placeholder");
  }

  @Test
  void offerWithoutAcceptsFails() {
    assertThatThrownBy(() -> resolve(with("x402.routes.r.description", "nothing to pay")))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("offer \"r\"")
        .hasMessageContaining("accepts");
  }

  @Test
  void optionWithoutPayToAfterContributorsFailsNamingOfferAndIndex() {
    assertThatThrownBy(() -> resolve(with(
        "x402.accounts.bare.network", "test:net",
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].price", "$1",
        "x402.routes.r.accepts[1].account", "bare",
        "x402.routes.r.accepts[1].price", "$1")))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("offer \"r\" accepts[1]")
        .hasMessageContaining("pay-to");
  }

  @Test
  void contributorSeesMergedOptionAndMayFillPayTo() {
    List<String> seen = new ArrayList<>();
    X402OptionContributor contributor = option -> {
      seen.add(option.offerName() + "/" + option.optionIndex() + "/" + option.accountName() + "/"
          + option.network() + "/" + option.extra());
      if (option.payTo() == null && option.payToRef() == null) {
        option.setPayTo("addr_derived");
        option.putExtra("derived", "yes");
      }
    };
    TestBinding.Bound bound = TestBinding.bind(with(
        "x402.accounts.escrow.network", "test:net",
        "x402.accounts.escrow.extra.assetTransferMethod", "masumi",
        "x402.routes.r.accepts[0].account", "escrow",
        "x402.routes.r.accepts[0].price.amount", "5",
        "x402.routes.r.accepts[0].price.asset", "USDM",
        "x402.routes.r.accepts[0].price.extra.fromPrice", "p",
        "x402.routes.r.accepts[0].price.extra.assetTransferMethod", "ignored",
        "x402.routes.r.accepts[0].extra.fromOption", "o"));
    X402Offers offers = OfferResolver.builder(bound.properties()).presence(bound.present())
        .facilitators(List.of(F)).contributors(List.of(contributor)).build().resolve();

    PaymentOption option = options(offers, "r").get(0);
    assertThat(option.payTo()).isEqualTo("addr_derived");
    assertThat(option.extra()).containsEntry("derived", "yes")
        .containsEntry("assetTransferMethod", "masumi").containsEntry("fromOption", "o");
    assertThat(seen).hasSize(1);
    assertThat(seen.get(0)).startsWith("r/0/escrow/test:net/")
        .contains("assetTransferMethod=masumi").contains("fromPrice=p").contains("fromOption=o");
  }

  @Test
  void contributorCannotChangeAnInheritedTransferMethod() {
    X402OptionContributor contributor = option -> option.putExtra("assetTransferMethod", "default");
    TestBinding.Bound bound = TestBinding.bind(with(
        "x402.accounts.escrow.network", "test:net",
        "x402.accounts.escrow.pay-to", "addr_escrow",
        "x402.accounts.escrow.extra.assetTransferMethod", "masumi",
        "x402.routes.r.accepts[0].account", "escrow",
        "x402.routes.r.accepts[0].price", "$5"));
    assertThatThrownBy(() -> OfferResolver.builder(bound.properties()).presence(bound.present())
        .facilitators(List.of(F)).contributors(List.of(contributor)).build().resolve())
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("offer \"r\" accepts[0]")
        .hasMessageContaining("assetTransferMethod");
  }

  @Test
  void optionChangingItsAccountsTransferMethodFails() {
    assertThatThrownBy(() -> resolve(with(
        "x402.accounts.escrow.network", "test:net",
        "x402.accounts.escrow.pay-to", "addr_escrow",
        "x402.accounts.escrow.extra.assetTransferMethod", "masumi",
        "x402.routes.r.accepts[0].account", "escrow",
        "x402.routes.r.accepts[0].price", "$5",
        "x402.routes.r.accepts[0].extra.assetTransferMethod", "default")))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("offer \"r\" accepts[0]")
        .hasMessageContaining("assetTransferMethod")
        .hasMessageContaining("escrow");
  }

  @Test
  void receiverResolvesAsOneChoicePerLayer() {
    X402DynamicPayTo treasury = ctx -> "addr_dynamic";
    TestBinding.Bound bound = TestBinding.bind(
        "x402.accounts.ref.network", "test:net",
        "x402.accounts.ref.pay-to-ref", "treasury",
        "x402.routes.r.accepts[0].account", "ref",
        "x402.routes.r.accepts[0].price", "$1",
        "x402.routes.r.accepts[1].account", "ref",
        "x402.routes.r.accepts[1].pay-to", "addr_static",
        "x402.routes.r.accepts[1].price", "$2");
    X402Offers offers = OfferResolver.builder(bound.properties()).presence(bound.present())
        .facilitators(List.of(F))
        .payToRefs(name -> "treasury".equals(name) ? treasury : null).build().resolve();

    List<PaymentOption> options = options(offers, "r");
    assertThat(options.get(0).payTo()).isNull();
    assertThat(options.get(0).payToResolver()).isNotNull();
    assertThat(options.get(1).payTo()).isEqualTo("addr_static");
    assertThat(options.get(1).payToResolver()).isNull();

    assertThatThrownBy(() -> resolve(with(
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].pay-to", "a",
        "x402.routes.r.accepts[0].pay-to-ref", "b",
        "x402.routes.r.accepts[0].price", "$1")))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("pay-to-ref");
  }

  @Test
  void priceRefResolvesItsBeanAndAnUnknownBeanFails() {
    X402DynamicPrice pricer = ctx -> new Money("$0.42");
    TestBinding.Bound bound = TestBinding.bind(with(
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].price-ref", "pricer"));
    X402Offers offers = OfferResolver.builder(bound.properties()).presence(bound.present())
        .facilitators(List.of(F)).priceRefs(name -> "pricer".equals(name) ? pricer : null)
        .build().resolve();
    assertThat(options(offers, "r").get(0).priceResolver()).isNotNull();

    assertThatThrownBy(() -> OfferResolver.builder(bound.properties()).presence(bound.present())
        .facilitators(List.of(F)).build().resolve())
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("pricer");
  }

  @Test
  void pinPrecedenceIsOptionThenAccountThenDefaults() {
    X402Offers offers = resolve(with(
        "x402.accounts.pinned.network", "test:net",
        "x402.accounts.pinned.pay-to", "addr_p",
        "x402.accounts.pinned.facilitator", "backup",
        "x402.defaults.facilitator", F,
        "x402.routes.r.accepts[0].account", "pinned",
        "x402.routes.r.accepts[0].price", "$1",
        "x402.routes.r.accepts[0].facilitator", F + "/",
        "x402.routes.r.accepts[1].account", "pinned",
        "x402.routes.r.accepts[1].price", "$2",
        "x402.routes.r.accepts[2].account", "preprod",
        "x402.routes.r.accepts[2].price", "$3"));

    List<PaymentOption> options = options(offers, "r");
    assertThat(options.get(0).facilitator()).isEqualTo(F);
    assertThat(options.get(1).facilitator()).isEqualTo("backup");
    assertThat(options.get(2).facilitator()).isEqualTo(F);
  }

  @Test
  void unknownPinFailsListingKnownIdentifiers() {
    assertThatThrownBy(() -> resolve(with(
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].price", "$1",
        "x402.routes.r.accepts[0].facilitator", "nope")))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("unknown facilitator \"nope\"")
        .hasMessageContaining("backup");
  }

  @Test
  void envLowercasedExtraKeyFails() {
    assertThatThrownBy(() -> resolve(with(
        "x402.accounts.preprod.extra.assettransfermethod", "masumi",
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].price", "$1")))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("assettransfermethod")
        .hasMessageContaining("assetTransferMethod");
  }

  @Test
  void accountNamesMustBeLowercaseDashed() {
    assertThatThrownBy(() -> resolve(
        "x402.accounts.[Pre_Prod].network", "test:net",
        "x402.accounts.[Pre_Prod].pay-to", "a",
        "x402.routes.r.accepts[0].account", "Pre_Prod",
        "x402.routes.r.accepts[0].price", "$1"))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("Pre_Prod")
        .hasMessageContaining("[a-z0-9-]+");
  }

  @Test
  void accountWithoutNetworkFails() {
    assertThatThrownBy(() -> resolve(
        "x402.accounts.nonet.pay-to", "a",
        "x402.routes.r.accepts[0].account", "nonet",
        "x402.routes.r.accepts[0].price", "$1"))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("account \"nonet\"")
        .hasMessageContaining("network");
  }

  @Test
  void unusedAccountWarns() {
    X402Offers offers = resolve(with(
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].price", "$1"));
    assertThat(offers.warnings()).anyMatch(w -> w.contains("account \"mainnet\""));
    assertThat(offers.warnings()).noneMatch(w -> w.contains("account \"preprod\""));
  }

  @Test
  void accountNameNeverReachesTheOption() {
    X402Offers offers = resolve(with(
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].price", "$1"));
    PaymentOption option = options(offers, "r").get(0);
    assertThat(String.valueOf(option.extra())).doesNotContain("preprod");
    assertThat(option.payTo()).isNotEqualTo("preprod");
  }

  @Test
  void dynamicPriceMayNotChangeTheTransferMethod() {
    X402DynamicPrice pricer = ctx -> new AssetAmount("USDM", "1",
        Map.of("assetTransferMethod", "masumi"));
    TestBinding.Bound bound = TestBinding.bind(with(
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].price-ref", "pricer"));
    X402Offers offers = OfferResolver.builder(bound.properties()).presence(bound.present())
        .facilitators(List.of(F)).priceRefs(name -> pricer).build().resolve();
    PaymentOption option = options(offers, "r").get(0);
    assertThatThrownBy(() -> option.priceResolver().resolve(null))
        .hasMessageContaining("assetTransferMethod");
  }

  @Test
  void staticUnknownPayToRefFails() {
    DynamicPayTo unused = ctx -> "x";
    assertThat(unused).isNotNull();
    assertThatThrownBy(() -> resolve(with(
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].pay-to-ref", "missing",
        "x402.routes.r.accepts[0].price", "$1")))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("missing");
  }

  @Test
  void offerKeepsRouteMetadata() {
    X402Offers offers = resolve(with(
        "x402.routes.r.path", "GET /report/*",
        "x402.routes.r.description", "Market report",
        "x402.routes.r.mime-type", "application/json",
        "x402.routes.r.failover", "true",
        "x402.routes.r.accepts[0].account", "preprod",
        "x402.routes.r.accepts[0].price", "$1"));
    ResolvedOffer offer = offers.offer("r");
    assertThat(offer.path()).isEqualTo("GET /report/*");
    assertThat(offer.route().description()).isEqualTo("Market report");
    assertThat(offer.route().mimeType()).isEqualTo("application/json");
    assertThat(offer.route().failover()).isTrue();
    assertThat(offers.names()).containsExactly("r");
    assertThat(TestServerScheme.USDM).isEqualTo("USDM");
  }
}
