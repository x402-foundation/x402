package org.x402.http.facilitator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.http.facilitator.FacilitatorTestSupport.PAYER;
import static org.x402.http.facilitator.FacilitatorTestSupport.PREPROD;
import static org.x402.http.facilitator.FacilitatorTestSupport.TX;

import java.time.Duration;
import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorClient;
import org.x402.core.FacilitatorStatusException;
import org.x402.core.InProcessFacilitatorClient;
import org.x402.core.facilitator.X402Facilitator;
import org.x402.core.hooks.HookResults.Decision;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.http.facilitator.FacilitatorTestSupport.HandlerServer;
import org.x402.http.facilitator.FacilitatorTestSupport.RecordingScheme;
import org.x402.http.facilitator.FacilitatorTestSupport.Vectors;

/** {@link LocalFacilitatorClient} answers exactly what the HTTP path answers. */
class LocalFacilitatorClientTest {

  private final RecordingScheme scheme = new RecordingScheme();
  private final X402Facilitator facilitator = new X402Facilitator().register(PREPROD, scheme);
  private final LocalFacilitatorClient local = new LocalFacilitatorClient(facilitator);
  private final HandlerServer server = new HandlerServer(
      new FacilitatorHttpHandler(facilitator, FacilitatorHttpHandler.DEFAULT_BASE_PATH));
  private final FacilitatorClient http = server.client("/x402");
  private final PaymentPayload payload = Vectors.payload();
  private final PaymentRequirements requirements = Vectors.requirements();

  @AfterEach
  void stop() {
    server.close();
  }

  /** Runs one call on both clients and returns the (equal) outcome. */
  private <T> T same(Function<FacilitatorClient, T> call) {
    T viaHttp = call.apply(http);
    T viaLocal = call.apply(local);
    assertThat(viaLocal).isEqualTo(viaHttp);
    return viaLocal;
  }

  /** Runs one failing call on both clients and checks the exceptions match. */
  private FacilitatorStatusException sameError(Function<FacilitatorClient, ?> call) {
    Throwable viaHttp = catchAny(() -> call.apply(http));
    Throwable viaLocal = catchAny(() -> call.apply(local));
    assertThat(viaHttp).isInstanceOf(FacilitatorStatusException.class);
    assertThat(viaLocal).isExactlyInstanceOf(viaHttp.getClass())
        .hasMessage(viaHttp.getMessage());
    assertThat(((FacilitatorStatusException) viaLocal).statusCode())
        .isEqualTo(((FacilitatorStatusException) viaHttp).statusCode());
    return (FacilitatorStatusException) viaLocal;
  }

  private static Throwable catchAny(Runnable r) {
    try {
      r.run();
    } catch (RuntimeException e) {
      return e;
    }
    throw new AssertionError("expected an exception");
  }

  private static String tsError(String vectorCase) {
    return Vectors.get(vectorCase).get("tsOutcome").get("error").get("message").asText();
  }

  @Test
  void itIsTheReservedInProcessClient() {
    assertThat(local).isInstanceOf(InProcessFacilitatorClient.class);
    assertThat(local.identifier()).isEqualTo("local").isEqualTo(LocalFacilitatorClient.IDENTIFIER);
    assertThat(local.verifyTimeout()).isEqualTo(Duration.ZERO);
    assertThat(local.settleTimeout()).isEqualTo(Duration.ZERO);
    assertThat(local.facilitator()).isSameAs(facilitator);
    assertThatThrownBy(() -> new LocalFacilitatorClient(null))
        .isInstanceOf(NullPointerException.class);
  }

  @Test
  void theResourceServerAcceptsItUnderTheReservedName() {
    X402ResourceServer resourceServer = X402ResourceServer.builder().facilitator(local).build();
    assertThat(resourceServer).isNotNull();
    assertThat(X402ResourceServer.builder().localFacilitator(local).build()).isNotNull();
  }

  @Test
  void valid() {
    assertThat(this.<VerifyResponse>same(c -> c.verify(payload, requirements)))
        .isEqualTo(VerifyResponse.valid(PAYER));
    assertThat(this.<SettleResponse>same(c -> c.settle(payload, requirements)))
        .isEqualTo(SettleResponse.success(TX, PREPROD, PAYER));
    assertThat(same(FacilitatorClient::getSupported).kinds()).hasSize(1);
    assertThat(scheme.payloads).hasSize(4);
    assertThat(scheme.payloads.get(1)).isEqualTo(scheme.payloads.get(0));
  }

  @Test
  void invalid() {
    scheme.verify = (p, r) -> new VerifyResponse(false, "insufficient_funds", "short", PAYER,
        null, null, null);
    scheme.settle = (p, r) -> SettleResponse.failure("transaction_failed", "rejected", "", PREPROD);
    assertThat(same(c -> c.verify(payload, requirements)).invalidReason())
        .isEqualTo("insufficient_funds");
    assertThat(same(c -> c.settle(payload, requirements)).errorReason())
        .isEqualTo("transaction_failed");
  }

  @Test
  void beforeVerifyAbort() {
    facilitator.onBeforeVerify(ctx -> Decision.abort("payee_not_allowed"));
    assertThat(this.<VerifyResponse>same(c -> c.verify(payload, requirements)))
        .isEqualTo(VerifyResponse.invalid("payee_not_allowed", null));
  }

  @Test
  void settleAbort() {
    facilitator.onBeforeSettle(ctx -> Decision.abort("payee_not_allowed"));
    SettleResponse result = same(c -> c.settle(payload, requirements));
    assertThat(result).isEqualTo(SettleResponse.failure("payee_not_allowed", null, "", PREPROD));
    assertThat(scheme.payloads).isEmpty();
  }

  @Test
  void error() {
    scheme.verify = (p, r) -> {
      throw new IllegalStateException("boom");
    };
    scheme.settle = (p, r) -> {
      throw new IllegalStateException("boom");
    };
    FacilitatorStatusException verify = sameError(c -> c.verify(payload, requirements));
    assertThat(verify).hasMessage(tsError("verify-error"));
    assertThat(verify.statusCode()).isEqualTo(500);
    assertThat(verify.getCause()).isInstanceOf(IllegalStateException.class).hasMessage("boom");
    assertThat(sameError(c -> c.settle(payload, requirements))).hasMessage(tsError("settle-error"));
  }

  @Test
  void supportedError() {
    scheme.extra = n -> {
      throw new IllegalStateException("boom");
    };
    assertThat(sameError(FacilitatorClient::getSupported)).hasMessage(tsError("supported-error"));
  }

  @Test
  void hookErrors() {
    facilitator.onBeforeVerify(ctx -> {
      throw new IllegalArgumentException("hook failed");
    });
    facilitator.onBeforeSettle(ctx -> {
      throw new IllegalArgumentException("hook failed");
    });
    sameError(c -> c.verify(payload, requirements));
    sameError(c -> c.settle(payload, requirements));
  }

  @Test
  void longAndMessagelessErrorsMatchToo() {
    String longMessage = "x".repeat(300) + " \n tail";
    scheme.verify = (p, r) -> {
      throw new IllegalStateException(longMessage);
    };
    scheme.settle = (p, r) -> {
      throw new IllegalStateException();
    };
    assertThat(sameError(c -> c.verify(payload, requirements)).getMessage()).hasSize(
        "Facilitator verify failed (500): ".length() + 200).endsWith("...");
    sameError(c -> c.settle(payload, requirements));
  }

  @Test
  void theExtensionResponsesSideChannelIsDroppedOnBothPaths() {
    Map<String, Object> side = Map.of("bazaar", Map.of("status", "ok"));
    scheme.verify = (p, r) -> new VerifyResponse(true, null, null, PAYER, Map.of("e", "v"), side,
        Map.of("x", "y"));
    scheme.settle = (p, r) -> new SettleResponse(true, null, null, PAYER, TX, PREPROD, "10000",
        Map.of("e", "v"), side, Map.of("x", "y"));
    assertThat(same(c -> c.verify(payload, requirements)).extensionResponses()).isNull();
    assertThat(same(c -> c.settle(payload, requirements)).extensionResponses()).isNull();
  }
}
