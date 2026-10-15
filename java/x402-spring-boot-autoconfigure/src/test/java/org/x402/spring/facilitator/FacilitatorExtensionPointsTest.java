package org.x402.spring.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.assertj.AssertableApplicationContext;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.x402.core.FacilitatorExtension;
import org.x402.core.PendingSettlementStore;
import org.x402.core.facilitator.InMemoryPendingSettlementStore;
import org.x402.core.facilitator.X402Facilitator;
import org.x402.core.hooks.HookResults;
import org.x402.core.types.SupportedKind;
import org.x402.core.types.SupportedResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.http.facilitator.FacilitatorHttpHandler;
import org.x402.mechanisms.cardano.chain.BlockfrostChainBackend;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorOptions;
import org.x402.mechanisms.cardano.exact.facilitator.ScriptDatumPolicy;
import org.x402.mechanisms.cardano.exact.facilitator.InMemorySettlementClaimStore;
import org.x402.mechanisms.cardano.exact.facilitator.SettlementClaimStore;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeploymentValidator;
import org.x402.mechanisms.cardano.exact.masumi.MasumiRegistryValidator;
import org.x402.spring.cardano.X402CardanoNetworkBeans;

/** Every facilitator override point takes effect. */
@ExtendWith(OutputCaptureExtension.class)
class FacilitatorExtensionPointsTest {

  private static final String PREPROD = "cardano:preprod";
  private static final String MAINNET = "cardano:mainnet";

  private static ApplicationContextRunner runner() {
    return new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402FacilitatorServerAutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitator-server.enabled=true",
            "x402.facilitator-server.cardano.networks[0].network=" + PREPROD,
            "x402.facilitator-server.cardano.networks[0].blockfrost.project-id=k");
  }

  private static ExactCardanoFacilitatorOptions options(AssertableApplicationContext ctx) {
    return ctx.getBean(CardanoFacilitatorSchemes.class).options(PREPROD);
  }

  private static BlockfrostChainBackend blockfrost(String network) {
    return new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder().network(network)
        .projectId("custom").build());
  }

  @Test
  void yamlConfirmationTimeoutAndPollReachTheScheme() {
    runner().withPropertyValues(
        "x402.facilitator-server.cardano.confirmation-timeout=30s",
        "x402.facilitator-server.cardano.confirmation-poll=2s")
        .run(ctx -> {
          assertThat(options(ctx).confirmationTimeout()).isEqualTo(Duration.ofSeconds(30));
          assertThat(options(ctx).confirmationPoll()).isEqualTo(Duration.ofSeconds(2));
        });
    runner().run(ctx -> {
      assertThat(options(ctx).confirmationTimeout()).isEqualTo(Duration.ofSeconds(75));
      assertThat(options(ctx).confirmationPoll()).isEqualTo(Duration.ofSeconds(5));
      assertThat(options(ctx).acceptMempool()).isFalse();
    });
  }

  @Test
  void aHookBeanCanAbortVerify() {
    runner().withBean(X402FacilitatorCustomizer.class, () -> f -> f
            .register("test:net", new FakeFacilitatorScheme("hooked"))
            .onBeforeVerify(c -> HookResults.Decision.abort("payee_not_allowed")))
        .run(ctx -> {
          VerifyResponse response = ctx.getBean(X402Facilitator.class).verify(
              FacilitatorWire.payload(null), FacilitatorWire.requirements());
          assertThat(response.isValid()).isFalse();
          assertThat(response.invalidReason()).isEqualTo("payee_not_allowed");
        });
  }

  @Test
  void masumiValidatorBeansAreWiredIntoTheScheme() {
    MasumiRegistryValidator registry = claim -> true;
    MasumiDeploymentValidator deployment = claim -> true;
    runner().withBean(MasumiRegistryValidator.class, () -> registry)
        .withBean(MasumiDeploymentValidator.class, () -> deployment)
        .run(ctx -> {
          assertThat(options(ctx).registryValidator()).isSameAs(registry);
          assertThat(options(ctx).deploymentValidator()).isSameAs(deployment);
        });
  }

  @Test
  void chainBackendsComeFromTheNetworkProviderOrASinglePlainBean() {
    BlockfrostChainBackend preprod = blockfrost(PREPROD);
    X402CardanoNetworkBeans byNetwork = new X402CardanoNetworkBeans() {
      @Override
      public CardanoChainBackend chainBackend(String network) {
        return PREPROD.equals(network) ? preprod : null;
      }
    };
    runner().withBean(X402CardanoNetworkBeans.class, () -> byNetwork).withPropertyValues(
            "x402.facilitator-server.cardano.networks[1].network=" + MAINNET,
            "x402.facilitator-server.cardano.networks[1].blockfrost.project-id=k2")
        .run(ctx -> {
          CardanoFacilitatorSchemes schemes = ctx.getBean(CardanoFacilitatorSchemes.class);
          assertThat(schemes.backend(PREPROD)).isSameAs(preprod);
          assertThat(schemes.backend(MAINNET)).isInstanceOf(BlockfrostChainBackend.class)
              .isNotSameAs(preprod);
        });
    runner().withBean(CardanoChainBackend.class, () -> preprod)
        .run(ctx -> assertThat(ctx.getBean(CardanoFacilitatorSchemes.class).backend(PREPROD))
            .isSameAs(preprod));
    runner().withBean(CardanoChainBackend.class, () -> preprod).withPropertyValues(
            "x402.facilitator-server.cardano.networks[1].network=" + MAINNET,
            "x402.facilitator-server.cardano.networks[1].blockfrost.project-id=k2")
        .run(ctx -> assertThat(ctx).hasFailed().getFailure()
            .hasStackTraceContaining("X402CardanoNetworkBeans"));
  }

  @Test
  void stores_clock_extensions_handler_andFacilitatorBack_off() {
    runner().run(ctx -> {
      assertThat(options(ctx).settlementStore()).isInstanceOf(InMemorySettlementClaimStore.class)
          .isSameAs(ctx.getBean(SettlementClaimStore.class));
      assertThat(ctx.getBean(PendingSettlementStore.class))
          .isInstanceOf(InMemoryPendingSettlementStore.class);
      assertThat(ctx.getBean(FacilitatorHttpHandler.class).basePath()).isEqualTo("/x402");
    });
    SettlementClaimStore store = new InMemorySettlementClaimStore(7);
    PendingSettlementStore pending = new InMemoryPendingSettlementStore();
    Clock clock = Clock.fixed(Instant.parse("2026-10-12T00:00:00Z"), ZoneOffset.UTC);
    FacilitatorExtension extension = () -> "my-extension";
    runner().withBean(SettlementClaimStore.class, () -> store)
        .withBean(PendingSettlementStore.class, () -> pending)
        .withBean(Clock.class, () -> clock)
        .withBean(FacilitatorExtension.class, () -> extension)
        .run(ctx -> {
          assertThat(options(ctx).settlementStore()).isSameAs(store);
          assertThat(ctx.getBean(PendingSettlementStore.class)).isSameAs(pending);
          assertThat(options(ctx).clock()).isSameAs(clock);
          X402Facilitator facilitator = ctx.getBean(X402Facilitator.class);
          assertThat(facilitator.getExtensions()).contains("my-extension");
          assertThat(facilitator.getSupported().extensions()).contains("my-extension");
        });
    X402Facilitator own = new X402Facilitator();
    FacilitatorHttpHandler handler = new FacilitatorHttpHandler(own, "/own");
    runner().withBean(X402Facilitator.class, () -> own)
        .withBean(FacilitatorHttpHandler.class, () -> handler)
        .run(ctx -> {
          assertThat(ctx.getBean(X402Facilitator.class)).isSameAs(own);
          assertThat(ctx.getBean(FacilitatorHttpHandler.class)).isSameAs(handler);
          assertThat(ctx.getBean(CardanoFacilitatorSchemes.class).forNetwork(PREPROD))
              .isNotNull();
        });
  }

  @Test
  void aCustomizerSchemeForMainnetWinsWhilePreprodStaysAuto() {
    runner().withPropertyValues(
            "x402.facilitator-server.cardano.networks[1].network=" + MAINNET,
            "x402.facilitator-server.cardano.networks[1].blockfrost.project-id=k2")
        .withBean(X402FacilitatorCustomizer.class,
            () -> f -> f.register(List.of(MAINNET), new FakeFacilitatorScheme("mine")))
        .run(ctx -> {
          SupportedResponse supported = ctx.getBean(X402Facilitator.class).getSupported();
          Map<String, Map<String, Object>> byNetwork = new java.util.LinkedHashMap<>();
          for (SupportedKind kind : supported.kinds()) {
            byNetwork.put(kind.network(), kind.extra());
          }
          assertThat(byNetwork.get(MAINNET)).containsEntry("marker", "mine");
          assertThat(byNetwork.get(PREPROD)).containsKey("assetTransferMethods");
          assertThat(ctx.getBean(CardanoFacilitatorSchemes.class).forNetwork(MAINNET))
              .isNotNull();
        });
  }

  @Test
  void aConfirmationTimeoutAbove85SecondsWarns(CapturedOutput output) {
    new SpringApplicationBuilder(X402FacilitatorServerAutoConfiguration.class)
        .web(WebApplicationType.NONE)
        .properties("x402.facilitator-server.enabled=true",
            "x402.facilitator-server.cardano.confirmation-timeout=90s",
            "x402.facilitator-server.cardano.networks[0].network=" + PREPROD,
            "x402.facilitator-server.cardano.networks[0].blockfrost.project-id=k")
        .run().close();
    assertThat(output.getOut() + output.getErr()).contains("confirmation-timeout")
        .contains("85");
  }

  @Test
  void disabledByDefault() {
    new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402FacilitatorServerAutoConfiguration.class))
        .run(ctx -> assertThat(ctx).doesNotHaveBean(X402Facilitator.class));
  }

  @Test
  void aSlotConfigReachesTheNetworksOptions() {
    runner().withPropertyValues(
            "x402.facilitator-server.cardano.networks[0].slot-config.zero-time=1000000",
            "x402.facilitator-server.cardano.networks[0].slot-config.zero-slot=10",
            "x402.facilitator-server.cardano.networks[0].slot-config.slot-length=2000")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          var slots = options(ctx).slotConfigFor(PREPROD);
          assertThat(slots.getZeroTime()).isEqualTo(1_000_000L);
          assertThat(slots.getZeroSlot()).isEqualTo(10L);
          assertThat(slots.getSlotLength()).isEqualTo(2000);
        });
  }

  @Test
  void evaluationCanBeTurnedOffPerNetwork() {
    runner().run(ctx -> assertThat(((BlockfrostChainBackend) ctx.getBean(CardanoFacilitatorSchemes.class)
        .backend(PREPROD)).config().evaluation()).isTrue());
    runner().withPropertyValues("x402.facilitator-server.cardano.networks[0].evaluation=false")
        .run(ctx -> assertThat(((BlockfrostChainBackend) ctx.getBean(CardanoFacilitatorSchemes.class)
            .backend(PREPROD)).config().evaluation()).isFalse());
  }

  @Test
  void aMasumiAllowlistReachesTheNetworksOptions() {
    String hash = "AB".repeat(28);
    runner().withPropertyValues("x402.facilitator-server.cardano.networks[0].masumi-allowed-script-hashes=" + hash)
        .run(ctx -> assertThat(options(ctx).masumiAllowedScriptHashes()).containsExactly("ab".repeat(28)));
    runner().run(ctx -> assertThat(options(ctx).masumiAllowedScriptHashes()).isEmpty());
  }

  @Test
  void aMalformedMasumiScriptHashFailsStartup() {
    runner().withPropertyValues("x402.facilitator-server.cardano.networks[0].masumi-allowed-script-hashes=abc")
        .run(ctx -> assertThat(ctx).hasFailed());
  }

  @Test
  void theScriptDatumPolicyBindsFromItsKebabName() {
    runner().run(ctx -> assertThat(options(ctx).scriptDatumPolicy()).isEqualTo(ScriptDatumPolicy.REFERENCE));
    runner().withPropertyValues("x402.facilitator-server.cardano.script-datum-policy=v3-optional")
        .run(ctx -> assertThat(options(ctx).scriptDatumPolicy()).isEqualTo(ScriptDatumPolicy.V3_OPTIONAL));
  }

  @Test
  void aCip34AliasConfiguresTheCanonicalNetworkAndRoutesBothForms() {
    new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402FacilitatorServerAutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitator-server.enabled=true",
            "x402.facilitator-server.cardano.networks[0].network=cip34:0-1",
            "x402.facilitator-server.cardano.networks[0].blockfrost.project-id=k")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(ctx.getBean(CardanoFacilitatorSchemes.class).networks()).containsExactly(PREPROD);
          assertThat(ctx.getBean(X402Facilitator.class).getSupported().kinds())
              .extracting(k -> k.network()).contains(PREPROD, "cip34:0-1");
        });
  }

  @Test
  void aNetworkConfiguredByIdAndAliasFailsStartup() {
    runner().withPropertyValues(
            "x402.facilitator-server.cardano.networks[1].network=cip34:0-1",
            "x402.facilitator-server.cardano.networks[1].blockfrost.project-id=k2")
        .run(ctx -> assertThat(ctx).hasFailed());
  }

  @Test
  void aPartialSlotConfigFailsStartup() {
    runner().withPropertyValues(
            "x402.facilitator-server.cardano.networks[0].slot-config.slot-length=2000")
        .run(ctx -> assertThat(ctx).hasFailed());
  }
}
