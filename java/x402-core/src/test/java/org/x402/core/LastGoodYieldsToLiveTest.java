package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.supported;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.x402.core.server.RoutingSnapshot;
import org.x402.core.server.X402ResourceServer;

/**
 * A kept answer only fills kinds that no facilitator answering now lists: a live facilitator
 * declared later takes over a kind from a failed one declared earlier.
 */
class LastGoodYieldsToLiveTest {

  private static final String MAINNET = "cardano:mainnet";

  @Test
  void aLiveFacilitatorTakesOverAKindFromOneThatKeptItsAnswer() {
    FakeFacilitatorClient a = new FakeFacilitatorClient("A",
        supported(kind(PREPROD), kind(MAINNET)));
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", supported(kind(PREPROD)));
    X402ResourceServer server = X402ResourceServer.builder().facilitators(List.of(a, b)).build();
    server.register("cardano:*", new FakeServerScheme());
    server.publish(server.sync());
    assertThat(server.snapshot().owner(2, PREPROD, "exact")).isEqualTo("A");

    a.failSupported(new IllegalStateException("A down for good"));
    for (int i = 0; i < 2; i++) {
      RoutingSnapshot next = server.sync();
      server.publish(next);
      assertThat(next.owner(2, PREPROD, "exact")).isEqualTo("B");
      // Nobody live lists mainnet, so A's kept answer still serves it.
      assertThat(next.owner(2, MAINNET, "exact")).isEqualTo("A");
      assertThat(next.failures()).containsOnlyKeys("A");
    }
  }
}
