package org.x402.spring;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.http.HttpResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.x402.http.X402Headers;

/**
 * Contract on both stacks: handler headers never leak through a failed settle or a 502, and a
 * paid handler reached by a dispatch the x402 filter did not see is never run unpaid.
 * Subclasses run it on WebMvc and WebFlux; their apps add a lowest-precedence filter that rewrites
 * {@code /rewrite-to-weather} to {@code /weather}.
 */
public abstract class X402DispatchAndSettleContract {

  @DynamicPropertySource
  static void x402Properties(DynamicPropertyRegistry registry) {
    X402StarterContract.contractProperties().forEach((k, v) -> registry.add(k, () -> v));
  }

  /**
   * The port of the app.
   *
   * @return the port
   */
  protected abstract int port();

  /**
   * The app's hook recorder.
   *
   * @return the recorder
   */
  protected abstract HookRecorder recorder();

  /**
   * The contract's facilitator.
   *
   * @return the facilitator
   */
  protected FakeFacilitator facilitator() {
    return X402StarterContract.FACILITATOR;
  }

  protected String url(String path) {
    return "http://127.0.0.1:" + port() + path;
  }

  protected HttpResponse<String> paid(String path, String mode) {
    HttpResponse<String> unpaid = TestHttp.get(url(path));
    assertThat(unpaid.statusCode()).as("unpaid " + path).isEqualTo(402);
    return TestHttp.get(url(path), X402Headers.PAYMENT_SIGNATURE, TestHttp.pay(unpaid, 0, mode));
  }

  @BeforeEach
  void resetFixtures() {
    facilitator().reset(HookRecorder.NET, HookRecorder.MAIN);
    recorder().reset();
  }

  private static void assertNoHandlerHeaders(HttpResponse<String> response) {
    assertThat(response.headers().firstValue("Location")).isEmpty();
    assertThat(response.headers().firstValue("X-Download-Token")).isEmpty();
    assertThat(response.headers().allValues("Set-Cookie"))
        .noneMatch(c -> c.contains("session=secret"));
  }

  @Test
  void aSettledRedirectKeepsItsHeaders() {
    HttpResponse<String> response = paid("/secret-redirect", null);

    assertThat(response.statusCode()).isEqualTo(302);
    assertThat(response.headers().firstValue("Location"))
        .hasValue("https://cdn.example/presigned?sig=secret");
    assertThat(response.headers().firstValue("X-Download-Token")).hasValue("secret-token");
    assertThat(TestHttp.settlement(response)).isNotNull();
  }

  @Test
  void aFailedSettleNeverReleasesTheHandlersHeaders() {
    HttpResponse<String> response = paid("/secret-redirect", "settle-fail");

    assertThat(response.statusCode()).isEqualTo(402);
    assertNoHandlerHeaders(response);
  }

  @Test
  void aFacilitatorErrorDuringSettleNeverReleasesTheHandlersHeaders() {
    HttpResponse<String> response = paid("/secret-redirect", "settle-garbage");

    assertThat(response.statusCode()).isEqualTo(502);
    assertNoHandlerHeaders(response);
  }

  @Test
  void aPaidHandlerReachedThroughARewriteIsNotRun() {
    HttpResponse<String> response = TestHttp.get(url("/rewrite-to-weather"));

    assertThat(response.statusCode()).isEqualTo(500);
    assertThat(response.body()).doesNotContain("sunny");
    assertThat(facilitator().count("verify")).isZero();
  }

  @Test
  void theDirectPaidRouteStillWorks() {
    HttpResponse<String> response = paid("/weather", null);

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).contains("sunny");
  }
}
