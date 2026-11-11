package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.Flow;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

/** The 402 buffer never holds more than its cap, however large the body. */
class X402HttpClientBoundedBodyTest {

  private static final int CAP = X402HttpClient.BODY_BUFFER_CAP;

  private static Flow.Subscription subscription(AtomicBoolean cancelled) {
    return new Flow.Subscription() {
      @Override
      public void request(long n) {
        // everything is pushed by the test
      }

      @Override
      public void cancel() {
        cancelled.set(true);
      }
    };
  }

  @Test
  void aTenMegabyteBodyNeverHoldsMoreThanTheCapAndIsCancelled() throws Exception {
    X402HttpClientBoundedBody body = new X402HttpClientBoundedBody(CAP);
    AtomicBoolean cancelled = new AtomicBoolean();
    body.onSubscribe(subscription(cancelled));
    long pushed = 0;
    for (int i = 0; i < 160 && !cancelled.get(); i++) {
      body.onNext(List.of(ByteBuffer.allocate(64 * 1024)));
      pushed += 64 * 1024;
    }
    body.onComplete();

    X402HttpClientBoundedBody.Result result = body.getBody().toCompletableFuture().get();
    assertThat(result.overflow()).isTrue();
    assertThat(result.bytes()).isEmpty();
    assertThat(body.peakRetained()).isLessThanOrEqualTo(CAP);
    assertThat(cancelled).isTrue();
    assertThat(pushed).isLessThan(10L * 1024 * 1024);
  }

  @Test
  void aBodyExactlyAtTheCapIsKept() throws Exception {
    X402HttpClientBoundedBody body = new X402HttpClientBoundedBody(CAP);
    body.onSubscribe(subscription(new AtomicBoolean()));
    body.onNext(List.of(ByteBuffer.allocate(CAP)));
    body.onComplete();

    X402HttpClientBoundedBody.Result result = body.getBody().toCompletableFuture().get();
    assertThat(result.overflow()).isFalse();
    assertThat(result.bytes()).hasSize(CAP);
  }
}
