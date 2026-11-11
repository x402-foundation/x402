package org.x402.mechanisms.cardano.exact.server;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorClient;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedKind;
import org.x402.core.types.SupportedResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.http.PaymentOption;
import org.x402.http.PatternRouteResolver;
import org.x402.http.RouteConfig;
import org.x402.http.RouteConfigurationError;
import org.x402.http.RouteValidationError;
import org.x402.http.X402HttpResourceServer;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * An option whose own configuration is invalid fails at startup as a configuration error, even
 * while some facilitator is down: no re-sync can heal it, so it never waits behind a 503.
 */
class InvalidOptionIsFatalTest {

  private static final String PREPROD = "cardano:preprod";

  private static FacilitatorClient facilitator(String id, SupportedResponse answer) {
    return new FacilitatorClient() {
      @Override
      public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements) {
        throw new UnsupportedOperationException();
      }

      @Override
      public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements) {
        throw new UnsupportedOperationException();
      }

      @Override
      public SupportedResponse getSupported() {
        if (answer == null) {
          throw new IllegalStateException(id + " down");
        }
        return answer;
      }

      @Override
      public String identifier() {
        return id;
      }
    };
  }

  private static SupportedResponse cardano() {
    Map<String, Object> extra = new LinkedHashMap<>();
    extra.put("assetTransferMethods", List.of("default"));
    extra.put("l1Confirmations", Map.of("minimum", -1, "maximum", 20));
    return new SupportedResponse(List.of(new SupportedKind(2, "exact", PREPROD, extra)),
        List.of(), Map.of());
  }

  @Test
  void anInvalidConfirmationPolicyIsFatalWhileAnotherFacilitatorIsDown() {
    X402ResourceServer core = X402ResourceServer.builder()
        .facilitators(List.of(facilitator("up", cardano()), facilitator("down", null))).build();
    core.register(PREPROD, new ExactCardanoServerScheme());
    PaymentOption option = PaymentOption.builder().scheme("exact").network(PREPROD)
        .payTo(TxBuilder.walletAddress()).price(new AssetAmount("lovelace", "1000000", Map.of()))
        .extra(Map.of("confirmationPolicy", Map.of("l1Confirmations", "soon"))).build();
    // Caught by the checks that need no facilitator, before any sync.
    assertThatThrownBy(() -> new X402HttpResourceServer(core, new PatternRouteResolver(
        Map.of("GET /paid", RouteConfig.builder().accepts(List.of(option)).build()))).initialize())
        .isInstanceOfSatisfying(RouteConfigurationError.class,
        e -> {
          assertThat(e.errors()).extracting(RouteValidationError::reason)
              .containsExactly(RouteValidationError.Reason.INVALID_OPTION);
          assertThat(e.onlyAwaitingFacilitators()).isFalse();
        });
  }

  @Test
  void theCheckOnItsOwnNamesTheProblem() {
    var scheme = new ExactCardanoServerScheme();
    assertThat(scheme.validateOption(PREPROD,
        Map.of("confirmationPolicy", Map.of("l1Confirmations", "soon"))))
        .contains("invalid confirmation policy");
    assertThat(scheme.validateOption(PREPROD, Map.of())).isNull();
  }

  @Test
  void aMasumiTemplateWithoutAnIssuerIsAConfigurationError() {
    var scheme = new ExactCardanoServerScheme();
    assertThat(scheme.validateOption(PREPROD, Map.of("assetTransferMethod", "masumi")))
        .contains("masumi");
  }
}
