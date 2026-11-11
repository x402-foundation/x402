package org.x402.spring.cardano;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.ApplicationContext;
import org.x402.core.json.X402Json;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentRequired;
import org.x402.http.PaymentOption;
import org.x402.http.X402HttpResourceServer;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.exact.masumi.MasumiBlueprint;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeployment;
import org.x402.mechanisms.cardano.exact.server.CardanoSellerSigner;
import org.x402.mechanisms.cardano.exact.server.ExactCardanoServerScheme;
import org.x402.spring.FakeFacilitator;
import org.x402.spring.TestAdapter;
import org.x402.spring.X402DynamicPayTo;
import org.x402.spring.X402ResourceServerCustomizer;
import org.x402.spring.autoconfigure.X402AutoConfiguration;
import org.x402.spring.offer.X402Offers;

/** Cardano from YAML alone on the resource-server side. */
@ExtendWith(OutputCaptureExtension.class)
class X402CardanoAutoConfigurationTest {

  static final String MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon "
      + "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon "
      + "abandon abandon abandon abandon art";
  static final String OTHER_MNEMONIC = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo "
      + "zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";
  static final String PREPROD = CardanoNetworks.PREPROD;
  static final String MAINNET = CardanoNetworks.MAINNET;
  static final String PREVIEW = CardanoNetworks.PREVIEW;
  static final String PLAIN_PREPROD =
      CardanoSellerSigner.fromMnemonic(MNEMONIC, PREPROD, 1).sellerAddress();
  static final String PLAIN_MAINNET =
      CardanoSellerSigner.fromMnemonic(MNEMONIC, MAINNET, 1).sellerAddress();
  static final String SELLER_PREPROD =
      CardanoSellerSigner.fromMnemonic(MNEMONIC, PREPROD).sellerAddress();
  static final String ESCROW_PREPROD =
      MasumiBlueprint.escrowAddress(PREPROD, MasumiDeployment.DEFAULT);
  static final MasumiDeployment CUSTOM = new MasumiDeployment("2",
      MasumiDeployment.DEFAULT.adminVkeys(), "600000");

  private static FakeFacilitator facilitator;

  @BeforeAll
  static void start() {
    facilitator = FakeFacilitator.start();
    stubCardanoKinds();
  }

  @AfterAll
  static void stop() {
    facilitator.close();
  }

  @BeforeEach
  void reset() {
    facilitator.reset();
    stubCardanoKinds();
  }

  private static void stubCardanoKinds() {
    Map<String, Object> capabilities = new LinkedHashMap<>();
    capabilities.put("assetTransferMethods", List.of("default", "masumi", "script"));
    capabilities.put("l1Confirmations", Map.of("minimum", -1, "maximum", 20));
    Map<String, Map<String, Object>> kinds = new LinkedHashMap<>();
    for (String network : List.of(PREPROD, MAINNET, PREVIEW)) {
      kinds.put(network, capabilities);
    }
    facilitator.supportedWithExtra(kinds);
  }

  private static WebApplicationContextRunner runner() {
    return new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class,
            X402CardanoAutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitators[0].url=" + facilitator.url(),
            "x402.accounts.preprod.network=" + PREPROD,
            "x402.accounts.preprod.pay-to=" + PLAIN_PREPROD,
            "x402.accounts.mainnet.network=" + MAINNET,
            "x402.accounts.mainnet.pay-to=" + PLAIN_MAINNET);
  }

  private static PaymentOption option(ApplicationContext ctx, String offer, int index) {
    return ctx.getBean(X402Offers.class).offer(offer).route().accepts().get(index);
  }

  private static String startupFailure(org.springframework.boot.test.context.assertj
      .AssertableWebApplicationContext ctx) {
    assertThat(ctx).hasFailed();
    StringBuilder all = new StringBuilder();
    for (Throwable t = ctx.getStartupFailure(); t != null; t = t.getCause()) {
      all.append(t.getMessage()).append('\n');
    }
    return all.toString();
  }

  @Test
  void aServerSchemeIsRegisteredForEveryUsedCardanoNetwork() {
    runner().withPropertyValues(
        "x402.routes.r.accepts[0].account=preprod",
        "x402.routes.r.accepts[0].price=$0.01",
        "x402.routes.r.accepts[1].account=mainnet",
        "x402.routes.r.accepts[1].price=$0.01")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          X402ResourceServer server = ctx.getBean(X402ResourceServer.class);
          assertThat(server.getRegisteredScheme(PREPROD, "exact"))
              .isInstanceOf(ExactCardanoServerScheme.class);
          assertThat(server.getRegisteredScheme(MAINNET, "exact"))
              .isInstanceOf(ExactCardanoServerScheme.class);
          assertThat(server.getRegisteredScheme(PREVIEW, "exact")).isNull();
        });
  }

  @Test
  void l1ConfirmationsBecomeAPolicyOnlyOnThatAccountsOptionsAndAnOptionPolicyWins() {
    List<String> seen = new ArrayList<>();
    runner().withPropertyValues(
        "x402.accounts.preprod.cardano.l1-confirmations=3",
        "x402.routes.r.accepts[0].account=preprod",
        "x402.routes.r.accepts[0].price=$0.01",
        "x402.routes.r.accepts[1].account=mainnet",
        "x402.routes.r.accepts[1].price=$0.01",
        "x402.routes.r.accepts[2].account=preprod",
        "x402.routes.r.accepts[2].price=$0.02",
        "x402.routes.r.accepts[2].extra.confirmationPolicy.l1Confirmations=0")
        .withBean(org.x402.spring.offer.X402OptionContributor.class,
            () -> o -> seen.add(o.accountName()))
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(option(ctx, "r", 0).extra())
              .containsEntry("confirmationPolicy", Map.of("l1Confirmations", 3));
          assertThat(option(ctx, "r", 1).extra() == null
              || !option(ctx, "r", 1).extra().containsKey("confirmationPolicy")).isTrue();
          assertThat(option(ctx, "r", 2).extra())
              .containsEntry("confirmationPolicy", Map.of("l1Confirmations", 0));
          assertThat(seen).containsExactly("preprod", "mainnet", "preprod");
        });
    runner().withPropertyValues(
        "x402.accounts.preprod.cardano.l1-confirmations=21",
        "x402.routes.r.accepts[0].account=preprod",
        "x402.routes.r.accepts[0].price=$0.01")
        .run(ctx -> assertThat(startupFailure(ctx)).contains("l1-confirmations"));
  }

  @Test
  void anEscrowAddressOnAPlainOptionFailsStartup() {
    runner().withPropertyValues(
        "x402.routes.r.accepts[0].account=preprod",
        "x402.routes.r.accepts[0].pay-to=" + ESCROW_PREPROD,
        "x402.routes.r.accepts[0].price=$0.01")
        .run(ctx -> assertThat(startupFailure(ctx)).contains("offer \"r\" accepts[0]")
            .contains("escrow"));
  }

  @Test
  void aPayToRefReturningAnEscrowOrWrongNetworkAddressIsRefusedPerRequest() {
    X402DynamicPayTo escrow = context -> ESCROW_PREPROD;
    X402DynamicPayTo testnetOnMainnet = context -> PLAIN_PREPROD;
    runner()
        .withBean("escrowPayTo", X402DynamicPayTo.class, () -> escrow)
        .withBean("testnetPayTo", X402DynamicPayTo.class, () -> testnetOnMainnet)
        .withPropertyValues(
            "x402.routes.a.path=GET /a",
            "x402.routes.a.accepts[0].account=preprod",
            "x402.routes.a.accepts[0].pay-to-ref=escrowPayTo",
            "x402.routes.a.accepts[0].price=$0.01",
            "x402.routes.b.path=GET /b",
            "x402.routes.b.accepts[0].account=mainnet",
            "x402.routes.b.accepts[0].pay-to-ref=testnetPayTo",
            "x402.routes.b.accepts[0].price=$0.01")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          X402HttpResourceServer http = ctx.getBean(X402HttpResourceServer.class);
          assertThatThrownBy(() -> http.processHttpRequest(TestAdapter.get("/a").context()))
              .hasMessageContaining("escrow");
          assertThatThrownBy(() -> http.processHttpRequest(TestAdapter.get("/b").context()))
              .hasMessageContaining(MAINNET);
        });
  }

  @Test
  void aMasumiPayToIsDerivedFromTheMergedMethodOnly(CapturedOutput output) {
    runner().withPropertyValues(
        "x402.accounts.preprod.cardano.masumi.seller-mnemonic=" + MNEMONIC,
        "x402.accounts.escrow.network=" + PREPROD,
        "x402.accounts.escrow.extra.assetTransferMethod=masumi",
        "x402.routes.r.accepts[0].account=escrow",
        "x402.routes.r.accepts[0].price=$1",
        "x402.routes.r.accepts[1].account=preprod",
        "x402.routes.r.accepts[1].price=$2",
        "x402.routes.r.accepts[2].network=" + PREPROD,
        "x402.routes.r.accepts[2].extra.assetTransferMethod=masumi",
        "x402.routes.r.accepts[2].price=$3")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(option(ctx, "r", 0).payTo()).isEqualTo(ESCROW_PREPROD);
          assertThat(option(ctx, "r", 1).payTo()).isEqualTo(PLAIN_PREPROD);
          assertThat(option(ctx, "r", 2).payTo()).isEqualTo(ESCROW_PREPROD);
        });
    runner().withPropertyValues(
        "x402.accounts.preprod.cardano.masumi.seller-mnemonic=" + MNEMONIC,
        "x402.routes.r.accepts[0].account=preprod",
        "x402.routes.r.accepts[0].price=$2")
        .run(ctx -> assertThat(ctx).hasNotFailed());
    assertThat(output.getOut() + output.getErr())
        .contains("account \"preprod\"").contains("masumi");
  }

  @Test
  void aTestnetAddressOnMainnetFailsStartup() {
    runner().withPropertyValues(
        "x402.accounts.mainnet.pay-to=" + PLAIN_PREPROD,
        "x402.routes.r.accepts[0].account=mainnet",
        "x402.routes.r.accepts[0].price=$0.01")
        .run(ctx -> assertThat(startupFailure(ctx)).contains(MAINNET)
            .contains("offer \"r\" accepts[0]"));
  }

  @Test
  void masumiSettingsAreTheUnionPerNetworkAndConflictsFail() {
    runner().withPropertyValues(
        "x402.accounts.escrow.network=" + PREPROD,
        "x402.accounts.escrow.extra.assetTransferMethod=masumi",
        "x402.accounts.escrow.cardano.masumi.seller-mnemonic=" + MNEMONIC,
        "x402.accounts.preprod.cardano.masumi.seller-return-address=" + PLAIN_PREPROD,
        "x402.routes.r.path=GET /r",
        "x402.routes.r.accepts[0].account=escrow",
        "x402.routes.r.accepts[0].price=$1")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          PaymentRequired required = TestAdapter.paymentRequired(ctx.getBean(
              X402HttpResourceServer.class).processHttpRequest(TestAdapter.get("/r").context()));
          String json = X402Json.write(required);
          assertThat(json).contains(SELLER_PREPROD).contains(PLAIN_PREPROD);
        });
    runner().withPropertyValues(
        "x402.accounts.escrow.network=" + PREPROD,
        "x402.accounts.escrow.extra.assetTransferMethod=masumi",
        "x402.accounts.escrow.cardano.masumi.seller-mnemonic=" + MNEMONIC,
        "x402.accounts.preprod.cardano.masumi.seller-mnemonic=" + OTHER_MNEMONIC,
        "x402.routes.r.accepts[0].account=escrow",
        "x402.routes.r.accepts[0].price=$1")
        .run(ctx -> assertThat(startupFailure(ctx)).contains("seller-mnemonic")
            .contains(PREPROD));
  }

  @Test
  void aSingleSellerBeanServesOnlyOneNetwork() {
    CardanoSellerSigner bean = CardanoSellerSigner.fromMnemonic(OTHER_MNEMONIC, PREPROD);
    runner().withBean(CardanoSellerSigner.class, () -> bean).withPropertyValues(
        "x402.accounts.escrow.network=" + PREPROD,
        "x402.accounts.escrow.extra.assetTransferMethod=masumi",
        "x402.routes.r.accepts[0].account=escrow",
        "x402.routes.r.accepts[0].price=$1",
        "x402.routes.r.accepts[1].account=mainnet",
        "x402.routes.r.accepts[1].price=$1")
        .run(ctx -> assertThat(startupFailure(ctx)).contains("X402CardanoNetworkBeans"));
  }

  @Test
  void theSellerComesFromTheAccountPropertyOrFromABean() {
    CardanoSellerSigner bean = CardanoSellerSigner.fromMnemonic(OTHER_MNEMONIC, PREPROD);
    WebApplicationContextRunner masumi = runner().withPropertyValues(
        "x402.accounts.escrow.network=" + PREPROD,
        "x402.accounts.escrow.extra.assetTransferMethod=masumi",
        "x402.routes.r.path=GET /r",
        "x402.routes.r.accepts[0].account=escrow",
        "x402.routes.r.accepts[0].price=$1");
    masumi.withPropertyValues("x402.accounts.escrow.cardano.masumi.seller-mnemonic=" + MNEMONIC)
        .run(ctx -> assertThat(X402Json.write(TestAdapter.paymentRequired(ctx.getBean(
            X402HttpResourceServer.class).processHttpRequest(TestAdapter.get("/r").context()))))
            .contains(SELLER_PREPROD));
    masumi.withBean(CardanoSellerSigner.class, () -> bean)
        .run(ctx -> assertThat(X402Json.write(TestAdapter.paymentRequired(ctx.getBean(
            X402HttpResourceServer.class).processHttpRequest(TestAdapter.get("/r").context()))))
            .contains(bean.sellerAddress()));
    X402CardanoNetworkBeans byNetwork = new X402CardanoNetworkBeans() {
      @Override
      public CardanoSellerSigner sellerSigner(String network) {
        return PREPROD.equals(network) ? bean : null;
      }
    };
    masumi.withBean(X402CardanoNetworkBeans.class, () -> byNetwork)
        .run(ctx -> assertThat(X402Json.write(TestAdapter.paymentRequired(ctx.getBean(
            X402HttpResourceServer.class).processHttpRequest(TestAdapter.get("/r").context()))))
            .contains(bean.sellerAddress()));
    masumi.run(ctx -> assertThat(startupFailure(ctx)).contains("seller")
        .contains("offer \"r\" accepts[0]"));
  }

  @Test
  void aMasumiPayToMustBeTheEscrowAddressAndCannotBeARef() {
    runner().withPropertyValues(
        "x402.accounts.escrow.network=" + PREPROD,
        "x402.accounts.escrow.pay-to=" + PLAIN_PREPROD,
        "x402.accounts.escrow.extra.assetTransferMethod=masumi",
        "x402.accounts.escrow.cardano.masumi.seller-mnemonic=" + MNEMONIC,
        "x402.routes.r.accepts[0].account=escrow",
        "x402.routes.r.accepts[0].price=$1")
        .run(ctx -> assertThat(startupFailure(ctx)).contains("escrow address")
            .contains(ESCROW_PREPROD));
    runner().withBean("ref", X402DynamicPayTo.class, () -> c -> ESCROW_PREPROD)
        .withPropertyValues(
            "x402.accounts.escrow.network=" + PREPROD,
            "x402.accounts.escrow.pay-to-ref=ref",
            "x402.accounts.escrow.extra.assetTransferMethod=masumi",
            "x402.accounts.escrow.cardano.masumi.seller-mnemonic=" + MNEMONIC,
            "x402.routes.r.accepts[0].account=escrow",
            "x402.routes.r.accepts[0].price=$1")
        .run(ctx -> assertThat(startupFailure(ctx)).contains("pay-to-ref"));
  }

  @Test
  void theMasumiDeploymentResolvesCanonicalCustomAccountLevelOrFails() {
    String customEscrow = MasumiBlueprint.escrowAddress(PREPROD, CUSTOM);
    String previewEscrow = MasumiBlueprint.escrowAddress(PREVIEW, CUSTOM);
    List<String> custom = new ArrayList<>(List.of(
        "x402.accounts.escrow.network=" + PREPROD,
        "x402.accounts.escrow.extra.assetTransferMethod=masumi",
        "x402.accounts.escrow.extra.deployment.requiredAdmins=2",
        "x402.accounts.escrow.extra.deployment.cooldownPeriod=600000",
        "x402.accounts.escrow.cardano.masumi.seller-mnemonic=" + MNEMONIC,
        "x402.routes.r.accepts[0].account=escrow",
        "x402.routes.r.accepts[0].price=$1"));
    for (int i = 0; i < CUSTOM.adminVkeys().size(); i++) {
      custom.add("x402.accounts.escrow.extra.deployment.adminVkeys[" + i + "]="
          + CUSTOM.adminVkeys().get(i));
    }
    runner().withPropertyValues(custom.toArray(String[]::new)).run(ctx -> {
      assertThat(ctx).hasNotFailed();
      assertThat(option(ctx, "r", 0).payTo()).isEqualTo(customEscrow);
      assertThat(option(ctx, "r", 0).extra().get("deployment")).isEqualTo(CUSTOM.toJson());
    });

    List<String> preview = new ArrayList<>(List.of(
        "x402.accounts.escrow.network=" + PREVIEW,
        "x402.accounts.escrow.extra.assetTransferMethod=masumi",
        "x402.accounts.escrow.cardano.masumi.seller-mnemonic=" + MNEMONIC,
        "x402.accounts.escrow.cardano.masumi.deployment.required-admins=2",
        "x402.accounts.escrow.cardano.masumi.deployment.cooldown-period=600000",
        "x402.routes.r.path=GET /r",
        "x402.routes.r.accepts[0].account=escrow",
        "x402.routes.r.accepts[0].price.amount=1000000",
        "x402.routes.r.accepts[0].price.asset=lovelace"));
    for (int i = 0; i < CUSTOM.adminVkeys().size(); i++) {
      preview.add("x402.accounts.escrow.cardano.masumi.deployment.admin-vkeys[" + i + "]="
          + CUSTOM.adminVkeys().get(i));
    }
    runner().withPropertyValues(preview.toArray(String[]::new)).run(ctx -> {
      assertThat(ctx).hasNotFailed();
      assertThat(option(ctx, "r", 0).payTo()).isEqualTo(previewEscrow);
      assertThat(X402Json.write(TestAdapter.paymentRequired(ctx.getBean(
          X402HttpResourceServer.class).processHttpRequest(TestAdapter.get("/r").context()))))
          .contains(previewEscrow);
    });

    runner().withPropertyValues(
        "x402.accounts.escrow.network=" + PREVIEW,
        "x402.accounts.escrow.extra.assetTransferMethod=masumi",
        "x402.accounts.escrow.cardano.masumi.seller-mnemonic=" + MNEMONIC,
        "x402.routes.r.accepts[0].account=escrow",
        "x402.routes.r.accepts[0].price.amount=1000000",
        "x402.routes.r.accepts[0].price.asset=lovelace")
        .run(ctx -> assertThat(startupFailure(ctx)).contains(PREVIEW).contains("deployment"));

    runner().withPropertyValues(
        "x402.accounts.escrow.network=" + PREPROD,
        "x402.accounts.escrow.extra.assetTransferMethod=masumi",
        "x402.accounts.escrow.cardano.masumi.seller-mnemonic=" + MNEMONIC,
        "x402.routes.r.accepts[0].account=escrow",
        "x402.routes.r.accepts[0].price=$1")
        .run(ctx -> assertThat(option(ctx, "r", 0).payTo()).isEqualTo(ESCROW_PREPROD));
  }

  @Test
  void aCustomizerRegisteredSchemeReplacesTheAutoOne() {
    ExactCardanoServerScheme mine = new ExactCardanoServerScheme();
    runner().withBean(X402ResourceServerCustomizer.class,
            () -> server -> server.register(PREPROD, mine))
        .withPropertyValues(
            "x402.routes.r.accepts[0].account=preprod",
            "x402.routes.r.accepts[0].price=$0.01")
        .run(ctx -> assertThat(ctx.getBean(X402ResourceServer.class)
            .getRegisteredScheme(PREPROD, "exact")).isSameAs(mine));
  }

  @Test
  void theDefaultTermsStorageBacksOffForABean() {
    org.x402.mechanisms.cardano.exact.masumi.MasumiTermsStorage storage =
        new org.x402.mechanisms.cardano.exact.masumi.InMemoryMasumiTermsStorage(5);
    runner().run(ctx -> assertThat(ctx).hasSingleBean(
        org.x402.mechanisms.cardano.exact.masumi.MasumiTermsStorage.class));
    runner().withBean(org.x402.mechanisms.cardano.exact.masumi.MasumiTermsStorage.class,
        () -> storage).run(ctx -> assertThat(ctx.getBean(
            org.x402.mechanisms.cardano.exact.masumi.MasumiTermsStorage.class))
            .isSameAs(storage));
  }
}
