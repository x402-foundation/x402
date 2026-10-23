package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.supported;

import org.junit.jupiter.api.Test;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;

/** A beforeSettle hook that throws a SettleException aborts the settle, as in TypeScript. */
class BeforeSettleExceptionTest {

  private final FakeFacilitatorClient f = new FakeFacilitatorClient("f", supported(kind(PREPROD)));
  private final X402ResourceServer server = X402ResourceServer.builder().facilitator(f).build();
  private final PaymentRequirements req = Fixtures.requirements();
  private final PaymentPayload payload = Fixtures.payload(req);

  BeforeSettleExceptionTest() {
    server.register(PREPROD, new FakeServerScheme());
  }

  @Test
  void aThrownSettleExceptionAbortsWithoutCallingTheFacilitator() {
    SettleException refusal = new SettleException(403,
        SettleResponse.failure("refused_by_policy", "no", "", PREPROD));
    server.onBeforeSettle(ctx -> {
      throw refusal;
    });
    server.initialize();
    assertThatThrownBy(() -> server.settlePayment(payload, req, null, "transport", null,
        SettlePhase.AFTER_HANDLER)).isSameAs(refusal);
    assertThat(f.settleCalls).hasValue(0);
  }
}
