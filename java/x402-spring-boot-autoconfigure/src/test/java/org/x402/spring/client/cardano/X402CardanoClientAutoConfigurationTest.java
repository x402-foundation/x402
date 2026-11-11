package org.x402.spring.client.cardano;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.assertj.AssertableApplicationContext;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.x402.core.client.X402Client;
import org.x402.core.client.X402ClientException;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.utils.CardanoConstants;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.chain.BlockfrostChainBackend;
import org.x402.mechanisms.cardano.exact.client.ClientCardanoSignResult;
import org.x402.mechanisms.cardano.exact.client.ClientCardanoSigner;
import org.x402.mechanisms.cardano.signer.ClientCardanoSignerConfig;
import org.x402.mechanisms.cardano.signer.MnemonicClientCardanoSigner;
import org.x402.spring.autoconfigure.X402AutoConfiguration;
import org.x402.spring.cardano.X402CardanoNetworkBeans;

/** The Cardano payment client from {@code x402.client.cardano.*}. */
class X402CardanoClientAutoConfigurationTest {

  static final String MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon "
      + "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon "
      + "abandon abandon abandon abandon art";
  static final String OTHER_MNEMONIC = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo "
      + "zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";
  static final String PREPROD = CardanoNetworks.PREPROD;
  static final String MAINNET = CardanoNetworks.MAINNET;

  private static ApplicationContextRunner runner() {
    return new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class,
            X402CardanoClientAutoConfiguration.class))
        .withPropertyValues(
            "x402.client.enabled=true",
            "x402.client.cardano.mnemonic=" + MNEMONIC,
            "x402.client.cardano.networks[0].network=" + PREPROD,
            "x402.client.cardano.networks[0].blockfrost.project-id=preprodKey");
  }

  private static String address(String mnemonic, String network) {
    return new MnemonicClientCardanoSigner(ClientCardanoSignerConfig.builder()
        .mnemonic(mnemonic).network(network)
        .walletProvider(new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder()
            .network(network).projectId("x").build()))
        .build()).getAddress();
  }

  private static PaymentRequirements requirement(String network, String asset) {
    return new PaymentRequirements("exact", network, asset, "1000000", "addr", 300, Map.of());
  }

  private static String failure(AssertableApplicationContext ctx) {
    assertThat(ctx).hasFailed();
    StringBuilder all = new StringBuilder();
    for (Throwable t = ctx.getStartupFailure(); t != null; t = t.getCause()) {
      all.append(t.getMessage()).append('\n');
    }
    return all.toString();
  }

  /** A signer that never signs. */
  static final class FixedSigner implements ClientCardanoSigner {
    @Override
    public String getAddress() {
      return "addr_test_fixed";
    }

    @Override
    public ClientCardanoSignResult buildAndSignPaymentTransaction(
        org.x402.mechanisms.cardano.exact.client.ClientCardanoSignInput input) {
      throw new UnsupportedOperationException();
    }
  }

  @Test
  void oneClientSchemePerNetworkEntryWithItsOwnBlockfrostProject() {
    runner().withPropertyValues(
        "x402.client.cardano.networks[1].network=" + MAINNET,
        "x402.client.cardano.networks[1].blockfrost.project-id=mainnetKey",
        "x402.client.cardano.networks[1].blockfrost.base-url=https://bf.example/api/v0")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          X402CardanoClients clients = ctx.getBean(X402CardanoClients.class);
          assertThat(clients.networks()).containsExactly(PREPROD, MAINNET);
          assertThat(clients.blockfrost(PREPROD).projectId()).isEqualTo("preprodKey");
          assertThat(clients.blockfrost(PREPROD).baseUrl())
              .isEqualTo(BlockfrostChainBackend.defaultBaseUrl(PREPROD));
          assertThat(clients.blockfrost(MAINNET).projectId()).isEqualTo("mainnetKey");
          assertThat(clients.blockfrost(MAINNET).baseUrl()).isEqualTo("https://bf.example/api/v0");
          X402Client client = ctx.getBean(X402Client.class);
          String usdmPreprod = CardanoConstants.USDM_PREPROD_ASSET;
          assertThat(client.selectPaymentRequirements(2,
              List.of(requirement(PREPROD, usdmPreprod))).network()).isEqualTo(PREPROD);
          assertThat(client.selectPaymentRequirements(2, List.of(new PaymentRequirements(
              "exact", MAINNET, CardanoConstants.USDM_MAINNET_ASSET, "100000", "addr", 300,
              Map.of()))).network()).isEqualTo(MAINNET);
        });
  }

  @Test
  void aNetworkEntryMayOverrideTheMnemonic() {
    runner().withPropertyValues(
        "x402.client.cardano.networks[1].network=" + MAINNET,
        "x402.client.cardano.networks[1].mnemonic=" + OTHER_MNEMONIC,
        "x402.client.cardano.networks[1].blockfrost.project-id=mainnetKey")
        .run(ctx -> {
          X402CardanoClients clients = ctx.getBean(X402CardanoClients.class);
          assertThat(clients.signer(PREPROD).getAddress()).isEqualTo(address(MNEMONIC, PREPROD));
          assertThat(clients.signer(MAINNET).getAddress())
              .isEqualTo(address(OTHER_MNEMONIC, MAINNET));
        });
  }

  @Test
  void aSignerBeanWinsAndAPlainBeanServesOnlyOneNetwork() {
    FixedSigner fixed = new FixedSigner();
    runner().withBean(ClientCardanoSigner.class, () -> fixed)
        .run(ctx -> assertThat(ctx.getBean(X402CardanoClients.class).signer(PREPROD))
            .isSameAs(fixed));
    runner().withBean(ClientCardanoSigner.class, () -> fixed).withPropertyValues(
        "x402.client.cardano.networks[1].network=" + MAINNET,
        "x402.client.cardano.networks[1].blockfrost.project-id=mainnetKey")
        .run(ctx -> assertThat(failure(ctx)).contains("X402CardanoNetworkBeans"));
    X402CardanoNetworkBeans byNetwork = new X402CardanoNetworkBeans() {
      @Override
      public ClientCardanoSigner clientSigner(String network) {
        return MAINNET.equals(network) ? fixed : null;
      }
    };
    runner().withBean(X402CardanoNetworkBeans.class, () -> byNetwork).withPropertyValues(
        "x402.client.cardano.networks[1].network=" + MAINNET,
        "x402.client.cardano.networks[1].blockfrost.project-id=mainnetKey")
        .run(ctx -> {
          X402CardanoClients clients = ctx.getBean(X402CardanoClients.class);
          assertThat(clients.signer(MAINNET)).isSameAs(fixed);
          assertThat(clients.signer(PREPROD).getAddress()).isEqualTo(address(MNEMONIC, PREPROD));
        });
  }

  @Test
  void lovelaceIsRefusedByDefaultSpendControlsAndAcceptedWhenAllowed() {
    runner().run(ctx -> assertThatThrownBy(() -> ctx.getBean(X402Client.class)
        .selectPaymentRequirements(2, List.of(requirement(PREPROD, "lovelace"))))
        .isInstanceOf(X402ClientException.class));
    runner().withPropertyValues(
        "x402.client.spend-controls.allowed-assets[0].network=" + PREPROD,
        "x402.client.spend-controls.allowed-assets[0].asset=lovelace")
        .run(ctx -> assertThat(ctx.getBean(X402Client.class).selectPaymentRequirements(2,
            List.of(requirement(PREPROD, "lovelace"))).asset()).isEqualTo("lovelace"));
  }

  @Test
  void misconfiguredNetworkEntriesFailStartup() {
    new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class,
            X402CardanoClientAutoConfiguration.class))
        .withPropertyValues("x402.client.enabled=true",
            "x402.client.cardano.networks[0].network=" + PREPROD,
            "x402.client.cardano.networks[0].blockfrost.project-id=k")
        .run(ctx -> assertThat(failure(ctx)).contains("mnemonic"));
    runner().withPropertyValues("x402.client.cardano.networks[0].network=eip155:8453")
        .run(ctx -> assertThat(failure(ctx)).contains("eip155:8453"));
    runner().withPropertyValues("x402.client.cardano.networks[0].blockfrost.project-id=")
        .run(ctx -> assertThat(failure(ctx)).contains("project-id"));
  }

  @Test
  void withoutCardanoNetworksNothingIsRegistered() {
    new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class,
            X402CardanoClientAutoConfiguration.class))
        .withPropertyValues("x402.client.enabled=true")
        .run(ctx -> assertThat(ctx.getBean(X402CardanoClients.class).networks()).isEmpty());
  }

  @Test
  void aSuppliedSignerNeedsNoBlockfrostSettings() {
    new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class,
            X402CardanoClientAutoConfiguration.class))
        .withPropertyValues("x402.client.enabled=true",
            "x402.client.cardano.networks[0].network=" + PREPROD)
        .withBean(ClientCardanoSigner.class, FixedSigner::new)
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(ctx.getBean(X402CardanoClients.class).signer(PREPROD))
              .isInstanceOf(FixedSigner.class);
        });
  }
}

