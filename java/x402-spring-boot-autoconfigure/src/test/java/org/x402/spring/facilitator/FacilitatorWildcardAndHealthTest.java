package org.x402.spring.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.Status;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.x402.core.facilitator.X402Facilitator;
import org.x402.core.types.SupportedKind;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import org.x402.mechanisms.cardano.chain.SubmissionResult;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;

/** The facilitator server: wildcard customizer claims and per-network health. */
class FacilitatorWildcardAndHealthTest {

  private static final String PREPROD = "cardano:preprod";

  private static ApplicationContextRunner runner() {
    return new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402FacilitatorServerAutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitator-server.enabled=true",
            "x402.facilitator-server.cardano.networks[0].network=" + PREPROD,
            "x402.facilitator-server.cardano.networks[0].blockfrost.project-id=k");
  }

  @Test
  void aWildcardCustomizerSchemeClaimsEveryCardanoNetwork() {
    runner().withBean(X402FacilitatorCustomizer.class,
            () -> f -> f.register(List.of("cardano:*"), new FakeFacilitatorScheme("wild")))
        .run(ctx -> {
          List<SupportedKind> kinds = ctx.getBean(X402Facilitator.class).getSupported().kinds();
          assertThat(kinds).noneMatch(k -> PREPROD.equals(k.network()));
          assertThat(kinds).anyMatch(k -> "cardano:*".equals(k.network()));
        });
  }

  /** A backend whose parameter lookup succeeds or fails. */
  static final class FakeBackend implements CardanoChainBackend {
    private final boolean reachable;

    FakeBackend(boolean reachable) {
      this.reachable = reachable;
    }

    @Override
    public UtxoSnapshot getUtxo(String ref, String network) {
      throw new UnsupportedOperationException();
    }

    @Override
    public long getCurrentSlot(String network) {
      return 1;
    }

    @Override
    public ProtocolParams getProtocolParameters(String network) {
      if (!reachable) {
        throw new IllegalStateException("blockfrost unreachable");
      }
      return null;
    }

    @Override
    public SubmissionResult submitTransaction(String signedTransactionBase64, String network) {
      throw new UnsupportedOperationException();
    }
  }

  @Test
  void theFacilitatorHealthReportsEachNetworksBackend() {
    runner().withBean(CardanoChainBackend.class, () -> new FakeBackend(true)).run(ctx -> {
      Health health = ctx.getBean(X402FacilitatorHealthIndicator.class).health();
      assertThat(health.getStatus()).isEqualTo(Status.UP);
      assertThat(health.getDetails().toString()).contains(PREPROD).contains("UP");
      assertThat(ctx.getBeanNamesForType(X402FacilitatorHealthIndicator.class))
          .containsExactly("x402-facilitatorHealthIndicator");
    });
    runner().withBean(CardanoChainBackend.class, () -> new FakeBackend(false)).run(ctx -> {
      Health health = ctx.getBean(X402FacilitatorHealthIndicator.class).health();
      assertThat(health.getStatus()).isEqualTo(Status.DOWN);
      assertThat(health.getDetails().toString()).contains("blockfrost unreachable");
    });
  }
}
