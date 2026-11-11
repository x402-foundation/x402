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
 * A route whose policy the facilitator cannot serve fails at startup, instead of answering 500
 * on every request.
 */
class FacilitatorSupportCheckTest {

  private static final String PREPROD = "cardano:preprod";

  private static SupportedKind kind(int minimum, int maximum, List<String> methods) {
    Map<String, Object> extra = new LinkedHashMap<>();
    extra.put("assetTransferMethods", methods);
    extra.put("l1Confirmations", Map.of("minimum", minimum, "maximum", maximum));
    return new SupportedKind(2, "exact", PREPROD, extra);
  }

  private static Map<String, Object> policy(int l1) {
    return Map.of("confirmationPolicy", Map.of("l1Confirmations", l1));
  }

  @Test
  void aPolicyOutsideTheFacilitatorRangeIsReported() {
    var scheme = new ExactCardanoServerScheme();
    assertThat(scheme.validateFacilitatorSupport(PREPROD, kind(0, 20, List.of("default")), List.of(),
        policy(-1))).contains("does not include -1");
    assertThat(scheme.validateFacilitatorSupport(PREPROD, kind(-1, 0, List.of("default")), List.of(),
        Map.of())).contains("does not include 1");
    assertThat(scheme.validateFacilitatorSupport(PREPROD, kind(0, 20, List.of("default")), List.of(),
        Map.of("assetTransferMethod", "masumi"))).contains("assetTransferMethod masumi");
  }

  @Test
  void aServableOrUnknownOptionPasses() {
    var scheme = new ExactCardanoServerScheme();
    assertThat(scheme.validateFacilitatorSupport(PREPROD, kind(-1, 0, List.of("default")), List.of(),
        policy(-1))).isNull();
    assertThat(scheme.validateFacilitatorSupport(PREPROD, kind(0, 0, List.of("default")), List.of(),
        null)).isNull();
    assertThat(scheme.validateFacilitatorSupport(PREPROD, kind(0, 0, List.of("default")), List.of()))
        .isNull();
  }

  private static X402HttpResourceServer http(SupportedKind kind, Map<String, Object> optionExtra) {
    FacilitatorClient facilitator = new FacilitatorClient() {
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
        return new SupportedResponse(List.of(kind), List.of(), Map.of());
      }

      @Override
      public String identifier() {
        return "f";
      }
    };
    X402ResourceServer core = X402ResourceServer.builder().facilitator(facilitator).build();
    core.register(PREPROD, new ExactCardanoServerScheme());
    PaymentOption option = PaymentOption.builder().scheme("exact").network(PREPROD)
        .payTo(TxBuilder.walletAddress()).price(new AssetAmount("lovelace", "1000000", Map.of()))
        .extra(optionExtra).build();
    Map<String, RouteConfig> routes = Map.of("GET /paid",
        RouteConfig.builder().accepts(List.of(option)).build());
    return new X402HttpResourceServer(core, new PatternRouteResolver(routes));
  }

  @Test
  void aMempoolPolicyAgainstAFacilitatorWithoutMempoolFailsAtStartup() {
    assertThatThrownBy(() -> http(kind(0, 20, List.of("default")), policy(-1)).initialize())
        .isInstanceOfSatisfying(RouteConfigurationError.class, e -> assertThat(e.errors())
            .extracting(RouteValidationError::reason)
            .containsExactly(RouteValidationError.Reason.FACILITATOR_CAPABILITY));
  }

  @Test
  void theDefaultPolicyAgainstAFacilitatorThatCannotConfirmFailsAtStartup() {
    assertThatThrownBy(() -> http(kind(-1, 0, List.of("default")), Map.of()).initialize())
        .isInstanceOf(RouteConfigurationError.class);
  }

  @Test
  void aSupportedPolicyStillInitializes() {
    assertThat(http(kind(-1, 0, List.of("default")), policy(-1)).initialize()).isNotNull();
  }
}
