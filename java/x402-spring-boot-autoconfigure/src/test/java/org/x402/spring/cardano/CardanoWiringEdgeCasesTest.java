package org.x402.spring.cardano;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.assertj.AssertableWebApplicationContext;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.x402.core.SchemeNetworkClient;
import org.x402.core.client.X402Client;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.http.PaymentOption;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoConstants;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.exact.masumi.MasumiBlueprint;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeployment;
import org.x402.mechanisms.cardano.exact.server.CardanoSellerSigner;
import org.x402.mechanisms.cardano.exact.server.ExactCardanoServerScheme;
import org.x402.spring.FakeFacilitator;
import org.x402.spring.X402ClientCustomizer;
import org.x402.spring.X402ResourceServerCustomizer;
import org.x402.spring.autoconfigure.X402AutoConfiguration;
import org.x402.spring.client.cardano.X402CardanoClientAutoConfiguration;
import org.x402.spring.offer.X402Offers;

/** Edge cases of the Cardano wiring: customizer precedence, escrow checks, Masumi, aliases. */
class CardanoWiringEdgeCasesTest {

  static final String MNEMONIC = X402CardanoAutoConfigurationTest.MNEMONIC;
  static final String OTHER = X402CardanoAutoConfigurationTest.OTHER_MNEMONIC;
  static final String PREPROD = CardanoNetworks.PREPROD;
  static final String PLAIN = X402CardanoAutoConfigurationTest.PLAIN_PREPROD;
  static final MasumiDeployment CUSTOM = X402CardanoAutoConfigurationTest.CUSTOM;

  private static FakeFacilitator facilitator;

  @BeforeAll
  static void start() {
    facilitator = FakeFacilitator.start();
    Map<String, Object> capabilities = new LinkedHashMap<>();
    capabilities.put("assetTransferMethods", List.of("default", "masumi", "script"));
    capabilities.put("l1Confirmations", Map.of("minimum", -1, "maximum", 20));
    Map<String, Map<String, Object>> kinds = new LinkedHashMap<>();
    kinds.put(PREPROD, capabilities);
    kinds.put("cip34:0-1", capabilities);
    facilitator.supportedWithExtra(kinds);
  }

  @AfterAll
  static void stop() {
    facilitator.close();
  }

  private static WebApplicationContextRunner runner() {
    return new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class,
            X402CardanoAutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitators[0].url=" + facilitator.url(),
            "x402.accounts.preprod.network=" + PREPROD,
            "x402.accounts.preprod.pay-to=" + PLAIN);
  }

  private static String failure(AssertableWebApplicationContext ctx) {
    assertThat(ctx).hasFailed();
    StringBuilder all = new StringBuilder();
    for (Throwable t = ctx.getStartupFailure(); t != null; t = t.getCause()) {
      all.append(t.getMessage()).append('\n');
    }
    return all.toString();
  }

  private static PaymentOption option(AssertableWebApplicationContext ctx, int index) {
    return ctx.getBean(X402Offers.class).offer("r").route().accepts().get(index);
  }

  private static List<String> deployment(String prefix, MasumiDeployment d) {
    List<String> kv = new ArrayList<>(List.of(prefix + ".requiredAdmins=" + d.requiredAdmins(),
        prefix + ".cooldownPeriod=" + d.cooldownPeriod()));
    for (int i = 0; i < d.adminVkeys().size(); i++) {
      kv.add(prefix + ".adminVkeys[" + i + "]=" + d.adminVkeys().get(i));
    }
    return kv;
  }

  // ---------------------------------------------------------------- customizer scheme precedence

  @Test
  void aWildcardCustomizerSchemeIsNotShadowedByTheAutoOne() {
    ExactCardanoServerScheme mine = new ExactCardanoServerScheme();
    runner().withBean(X402ResourceServerCustomizer.class,
            () -> server -> server.register("cardano:*", mine))
        .withPropertyValues("x402.routes.r.accepts[0].account=preprod",
            "x402.routes.r.accepts[0].price=$0.01")
        .run(ctx -> assertThat(ctx.getBean(X402ResourceServer.class)
            .getRegisteredScheme(PREPROD, "exact")).isSameAs(mine));
  }

  /** Records that it signed. */
  static final class RecordingScheme implements SchemeNetworkClient {
    final List<String> signed = new ArrayList<>();

    @Override
    public String scheme() {
      return "exact";
    }

    @Override
    public PaymentPayloadResult createPaymentPayload(int x402Version,
        PaymentRequirements requirements, PaymentPayloadContext context) {
      signed.add(requirements.network());
      return new PaymentPayloadResult(x402Version, Map.of("transaction", "hsm"), null);
    }

    @Override
    public DefaultAsset findDefaultAsset(String asset, String network) {
      return CardanoConstants.USDM_PREPROD_ASSET.equals(asset)
          ? new DefaultAsset(asset, 6, "USDM") : null;
    }
  }

  @Test
  void aWildcardClientCustomizerWinsOverTheYamlWallet() {
    RecordingScheme hsm = new RecordingScheme();
    new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class,
            X402CardanoClientAutoConfiguration.class))
        .withBean(X402ClientCustomizer.class, () -> client -> client.register("cardano:*", hsm))
        .withPropertyValues("x402.client.enabled=true",
            "x402.client.cardano.mnemonic=" + MNEMONIC,
            "x402.client.cardano.networks[0].network=" + PREPROD,
            "x402.client.cardano.networks[0].blockfrost.project-id=k")
        .run(ctx -> {
          ctx.getBean(X402Client.class).createPaymentPayload(new PaymentRequired(2, null,
              ResourceInfo.of("https://api.example.com/x"), List.of(new PaymentRequirements(
                  "exact", PREPROD, CardanoConstants.USDM_PREPROD_ASSET, "10000", PLAIN, 300,
                  Map.of())), null));
          assertThat(hsm.signed).containsExactly(PREPROD);
        });
  }

  // ---------------------------------------------------------------- escrow script credential

  @Test
  void aBaseAddressWithTheEscrowScriptAsPaymentCredentialIsRefused() {
    String scriptHash = MasumiBlueprint.escrowScriptHash(MasumiDeployment.DEFAULT);
    byte[] bytes = new byte[57];
    bytes[0] = 0x10;
    for (int i = 0; i < 28; i++) {
      bytes[1 + i] = (byte) Integer.parseInt(scriptHash.substring(2 * i, 2 * i + 2), 16);
      bytes[29 + i] = 0x01;
    }
    String disguised = CardanoAddresses.toBech32(bytes);
    runner().withPropertyValues(
            "x402.routes.r.accepts[0].account=preprod",
            "x402.routes.r.accepts[0].pay-to=" + disguised,
            "x402.routes.r.accepts[0].price=$0.01")
        .run(ctx -> assertThat(failure(ctx)).contains("escrow"));
  }

  // ---------------------------------------------------------------- price.extra Masumi keys

  @Test
  void aDeploymentDeclaredInPriceExtraIsKnownBeforeEarlierOptionsAreChecked() {
    String customEscrow = MasumiBlueprint.escrowAddress(PREPROD, CUSTOM);
    List<String> kv = new ArrayList<>(List.of(
        "x402.accounts.preprod.cardano.masumi.seller-mnemonic=" + MNEMONIC,
        "x402.routes.r.accepts[0].account=preprod",
        "x402.routes.r.accepts[0].pay-to=" + customEscrow,
        "x402.routes.r.accepts[0].price=$1",
        "x402.routes.r.accepts[1].network=" + PREPROD,
        "x402.routes.r.accepts[1].extra.assetTransferMethod=masumi",
        "x402.routes.r.accepts[1].price.amount=2000000",
        "x402.routes.r.accepts[1].price.asset=lovelace"));
    kv.addAll(deployment("x402.routes.r.accepts[1].price.extra.deployment", CUSTOM));
    runner().withPropertyValues(kv.toArray(String[]::new))
        .run(ctx -> assertThat(failure(ctx)).contains("offer \"r\" accepts[0]")
            .contains("escrow"));
  }

  @Test
  void aMasumiMethodInPriceExtraUsesTheAccountsSeller() {
    runner().withPropertyValues(
            "x402.accounts.escrow.network=" + PREPROD,
            "x402.accounts.escrow.cardano.masumi.seller-mnemonic=" + MNEMONIC,
            "x402.routes.r.accepts[0].account=escrow",
            "x402.routes.r.accepts[0].price.amount=2000000",
            "x402.routes.r.accepts[0].price.asset=lovelace",
            "x402.routes.r.accepts[0].price.extra.assetTransferMethod=masumi")
        .run(ctx -> assertThat(ctx).hasNotFailed());
  }

  // ---------------------------------------------------------------- confirmation policy precedence

  @Test
  void accountL1ConfirmationsBeatAConfirmationPolicyInPriceExtra() {
    runner().withPropertyValues(
            "x402.accounts.preprod.cardano.l1-confirmations=2",
            "x402.routes.r.accepts[0].account=preprod",
            "x402.routes.r.accepts[0].price.amount=2000000",
            "x402.routes.r.accepts[0].price.asset=lovelace",
            "x402.routes.r.accepts[0].price.extra.confirmationPolicy.l1Confirmations=5")
        .run(ctx -> assertThat(option(ctx, 0).extra())
            .containsEntry("confirmationPolicy", Map.of("l1Confirmations", 2)));
  }

  // ---------------------------------------------------------------- malformed deployment

  @Test
  void aNonObjectDeploymentFailsWithAClearMessage() {
    runner().withPropertyValues(
            "x402.accounts.preprod.cardano.masumi.seller-mnemonic=" + MNEMONIC,
            "x402.routes.r.accepts[0].network=" + PREPROD,
            "x402.routes.r.accepts[0].extra.assetTransferMethod=masumi",
            "x402.routes.r.accepts[0].extra.deployment=canonical",
            "x402.routes.r.accepts[0].price=$1")
        .run(ctx -> assertThat(failure(ctx)).contains("extra.deployment must be an object"));
  }

  // ---------------------------------------------------------------- plain seller beans

  @Test
  void twoPlainSellerBeansFailUnlessOneIsPrimary() {
    runner()
        .withBean("sellerA", CardanoSellerSigner.class,
            () -> CardanoSellerSigner.fromMnemonic(MNEMONIC, PREPROD))
        .withBean("sellerB", CardanoSellerSigner.class,
            () -> CardanoSellerSigner.fromMnemonic(OTHER, PREPROD))
        .withPropertyValues(
            "x402.accounts.escrow.network=" + PREPROD,
            "x402.accounts.escrow.extra.assetTransferMethod=masumi",
            "x402.routes.r.accepts[0].account=escrow",
            "x402.routes.r.accepts[0].price=$1")
        .run(ctx -> assertThat(failure(ctx)).contains("@Primary"));
  }

  // ---------------------------------------------------------------- CIP-34 aliases

  @Test
  void cip34AliasesAreTheSameNetwork() {
    runner().withPropertyValues(
            "x402.accounts.alias.network=cip34:0-1",
            "x402.accounts.alias.extra.assetTransferMethod=masumi",
            "x402.accounts.alias.cardano.masumi.seller-mnemonic=" + MNEMONIC,
            "x402.accounts.preprod.cardano.masumi.seller-mnemonic=" + OTHER,
            "x402.routes.r.accepts[0].account=alias",
            "x402.routes.r.accepts[0].price=$1",
            "x402.routes.r.accepts[1].account=preprod",
            "x402.routes.r.accepts[1].price=$2")
        .run(ctx -> assertThat(failure(ctx)).contains("seller-mnemonic"));
  }

  // ---------------------------------------------------------------- Masumi template rules

  @Test
  void masumiTemplateRulesAreCheckedAtStartup() {
    WebApplicationContextRunner masumi = runner().withPropertyValues(
        "x402.accounts.escrow.network=" + PREPROD,
        "x402.accounts.escrow.extra.assetTransferMethod=masumi",
        "x402.accounts.escrow.cardano.masumi.seller-mnemonic=" + MNEMONIC,
        "x402.routes.r.accepts[0].account=escrow",
        "x402.routes.r.accepts[0].price=$1");
    masumi.withPropertyValues("x402.routes.r.accepts[0].max-timeout-seconds=3000000")
        .run(ctx -> assertThat(failure(ctx)).contains("horizon"));
    masumi.withPropertyValues("x402.routes.r.accepts[0].extra.note=x")
        .run(ctx -> assertThat(failure(ctx)).contains("may only carry"));
    masumi.run(ctx -> assertThat(ctx).hasNotFailed());
  }
}
