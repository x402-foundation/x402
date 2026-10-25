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
 * A facilitator serving from a kept answer (it failed the last sync) is the last failover
 * candidate, after every live one: the single failover attempt goes to a facilitator that is up.
 */
class FailoverSkipsKeptAnswersTest {

  @Test
  void aLiveFacilitatorIsTriedBeforeOneThatFailedTheLastSync() {
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind(PREPROD)));
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", supported(kind(PREPROD)));
    FakeFacilitatorClient c = new FakeFacilitatorClient("C", supported(kind(PREPROD)));
    X402ResourceServer server = X402ResourceServer.builder().facilitators(List.of(a, b, c))
        .build();
    server.register("cardano:*", new FakeServerScheme());
    server.publish(server.sync());
    a.failSupported(new IllegalStateException("A down"));
    RoutingSnapshot next = server.sync();
    server.publish(next);

    assertThat(next.owner(2, PREPROD, "exact")).isEqualTo("B");
    assertThat(server.failoverCandidates(next, "B", 2, PREPROD, "exact")).containsExactly("C", "A");
  }
}
