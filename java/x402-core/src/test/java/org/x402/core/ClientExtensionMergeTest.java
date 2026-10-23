package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.map;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.x402.core.client.SpendControls;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;

/** Extension merge: builder-code {@code s} concatenates, other leaves keep the server's. */
class ClientExtensionMergeTest {

  private PaymentPayload pay(Object serverExt, Object clientExt) {
    FakeClientScheme scheme = new FakeClientScheme();
    scheme.extensions = map("builder-code", clientExt);
    X402Client client = new X402Client().register(PREPROD, scheme)
        .setSpendControls(SpendControls.disabled());
    PaymentRequirements r = Fixtures.requirements();
    return client.createPaymentPayload(new PaymentRequired(2, null, null, List.of(r),
        map("builder-code", serverExt)));
  }

  @Test
  void serviceCodesConcatenateClientFirstWithoutDuplicates() {
    PaymentPayload p = pay(map("info", map("a", "app", "s", List.of("srv", "dup"))),
        map("info", map("s", List.of("cli", "dup"), "a", "forged")));
    assertThat(p.extensions().get("builder-code"))
        .isEqualTo(map("info", map("a", "app", "s", List.of("cli", "dup", "srv"))));
  }

  @Test
  void aScalarMergesAsASingleElementArray() {
    PaymentPayload p = pay(map("info", map("s", List.of("srv"))), map("info", map("s", "cli")));
    assertThat(p.extensions().get("builder-code"))
        .isEqualTo(map("info", map("s", List.of("cli", "srv"))));
  }

  @Test
  void nonObjectsAndMissingFieldsTakeTheClientValue() {
    assertThat(pay("server", map("x", 1)).extensions().get("builder-code"))
        .isEqualTo(map("x", 1));
    assertThat(pay(map("info", map()), map("info", map("s", List.of("cli"))))
        .extensions().get("builder-code")).isEqualTo(map("info", map("s", List.of("cli"))));
    assertThat(pay(map("info", map("s", map("o", 1))), map("info", map("s", List.of("cli"))))
        .extensions().get("builder-code")).isEqualTo(map("info", map("s", map("o", 1))));
  }
}
