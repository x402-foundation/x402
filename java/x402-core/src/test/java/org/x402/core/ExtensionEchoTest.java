package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.core.Fixtures.map;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.server.ExtensionValidation;
import org.x402.core.server.ResourceServerExtension;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;

/** Client extension echoes must preserve the server's advertisement. */
class ExtensionEchoTest {

  private final X402ResourceServer server = X402ResourceServer.builder()
      .facilitator(new FakeFacilitatorClient("f", Fixtures.supported(Fixtures.kind(
          Fixtures.PREPROD)))).build().registerExtension(new ResourceServerExtension() {
        @Override
        public String key() {
          return "quote";
        }

        @Override
        public List<String> dynamicInfoFields() {
          return List.of("nonce");
        }
      });
  private final PaymentRequirements req = Fixtures.requirements();

  private ExtensionValidation check(Map<String, Object> advertised, Map<String, Object> echoed) {
    PaymentRequired required = new PaymentRequired(2, null, null, List.of(req), advertised);
    PaymentPayload payload = new PaymentPayload(2, null, req, Map.of(), echoed);
    return server.validateExtensions(required, payload);
  }

  @Test
  void noEchoOrV1IsValid() {
    assertThat(check(map("quote", 1), null)).isEqualTo(ExtensionValidation.VALID);
    assertThat(check(map("quote", 1), Map.of())).isEqualTo(ExtensionValidation.VALID);
    PaymentRequired required = new PaymentRequired(2, null, null, List.of(req), map("quote", 1));
    assertThat(server.validateExtensions(required,
        new PaymentPayload(1, null, req, Map.of(), map("quote", 2))).valid()).isTrue();
  }

  @Test
  void echoesMustContainTheAdvertisedInfoMinusDynamicFields() {
    Map<String, Object> advertised = map("quote", map("info", map("price", 1, "nonce", "a")));
    assertThat(check(advertised, map("quote", map("info", map("price", 1, "nonce", "b",
        "extra", true)))).valid()).isTrue();
    assertThat(check(advertised, map("quote", map("info", map("price", 2)))))
        .isEqualTo(ExtensionValidation.mismatch("quote"));
    assertThat(check(advertised, map("unadvertised", 1)).valid()).isTrue();
  }

  @Test
  void builderCodeServiceCodesAreAdditiveButCapped() {
    Map<String, Object> advertised = map("builder-code",
        map("info", map("a", "app-1", "s", List.of("srv"))));
    assertThat(check(advertised, map("builder-code",
        map("info", map("a", "app-1", "s", List.of("cli", "srv"))))).valid()).isTrue();
    assertThat(check(advertised, map("builder-code",
        map("info", map("a", "app-1", "s", "srv")))).valid()).isTrue();
    assertThat(check(advertised, map("builder-code",
        map("info", map("a", "app-1", "s", List.of("cli")))))).isEqualTo(
        ExtensionValidation.mismatch("builder-code"));
    assertThat(check(advertised, map("builder-code", map("info", map("a", "app-1", "s",
        List.of("1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "srv"))))).valid()).isFalse();
    assertThat(check(advertised, map("builder-code",
        map("info", map("a", "app-1", "s", map("x", 1))))).valid()).isFalse();
  }

  @Test
  void clientsMayNotInventServerOwnedFields() {
    assertThat(check(null, map("builder-code", map("info", map("a", "forged")))))
        .isEqualTo(ExtensionValidation.mismatch("builder-code"));
    assertThat(check(map("other", 1), map("builder-code", map("info", map("s", "x")))).valid())
        .isTrue();
    assertThat(check(map("builder-code", map("info", map("a", "app"))),
        map("builder-code", "scalar")).valid()).isFalse();
    assertThat(check(null, map("builder-code", "scalar")).valid()).isTrue();
    // a JSON null is a present value (only an absent key is skipped)
    assertThat(check(null, map("builder-code", map("info", map("a", null)))).valid()).isFalse();
    assertThat(check(null, map("builder-code", map("info", map("s", List.of())))).valid())
        .isTrue();
  }
}
