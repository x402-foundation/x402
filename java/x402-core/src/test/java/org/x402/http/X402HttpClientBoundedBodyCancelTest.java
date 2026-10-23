package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.Flow;
import org.junit.jupiter.api.Test;

/**
 * On HTTP/2 the JDK fails a stream the subscriber cancels ("Stream N cancelled") by calling its
 * onError: the overflow result must already be in place and survive that error.
 */
class X402HttpClientBoundedBodyCancelTest {

  @Test
  void anErrorSignalledByTheCancelDoesNotReplaceTheOverflowResult() throws Exception {
    X402HttpClientBoundedBody body = new X402HttpClientBoundedBody(X402HttpClient.BODY_BUFFER_CAP);
    body.onSubscribe(new Flow.Subscription() {
      @Override
      public void request(long n) {
        // pushed by the test
      }

      @Override
      public void cancel() {
        body.onError(new IOException("Stream 1 cancelled"));
      }
    });
    body.onNext(List.of(ByteBuffer.allocate(X402HttpClient.BODY_BUFFER_CAP + 1)));

    X402HttpClientBoundedBody.Result result = body.getBody().toCompletableFuture().get();
    assertThat(result.overflow()).isTrue();
  }
}
