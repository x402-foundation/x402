package org.x402.http;

import java.io.ByteArrayOutputStream;
import java.net.http.HttpResponse.BodySubscriber;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;

/**
 * Collects a response body up to a cap. Past the cap it drops what it holds, cancels the stream
 * and reports an overflow, so at most {@code cap} bytes are ever retained.
 */
final class X402HttpClientBoundedBody
    implements BodySubscriber<X402HttpClientBoundedBody.Result> {

  /**
   * The outcome.
   *
   * @param bytes the whole body, empty on overflow
   * @param overflow whether the body was larger than the cap
   */
  record Result(byte[] bytes, boolean overflow) {}

  private final int cap;
  private final CompletableFuture<Result> body = new CompletableFuture<>();
  private ByteArrayOutputStream out = new ByteArrayOutputStream();
  private Flow.Subscription subscription;
  private boolean done;
  private int peak;

  X402HttpClientBoundedBody(int cap) {
    this.cap = cap;
  }

  /** The most bytes held at any moment (for tests). */
  synchronized int peakRetained() {
    return peak;
  }

  @Override
  public CompletionStage<Result> getBody() {
    return body;
  }

  @Override
  public synchronized void onSubscribe(Flow.Subscription s) {
    this.subscription = s;
    s.request(Long.MAX_VALUE);
  }

  @Override
  public synchronized void onNext(List<ByteBuffer> items) {
    if (done) {
      return;
    }
    for (ByteBuffer item : items) {
      int n = item.remaining();
      if ((long) out.size() + n > cap) {
        done = true;
        out = new ByteArrayOutputStream(0);
        // Complete first: on HTTP/2 the cancel itself fails the stream ("Stream N cancelled"),
        // and that error must not replace the overflow result.
        body.complete(new Result(new byte[0], true));
        subscription.cancel();
        return;
      }
      byte[] chunk = new byte[n];
      item.get(chunk);
      out.write(chunk, 0, n);
      peak = Math.max(peak, out.size());
    }
  }

  @Override
  public synchronized void onError(Throwable throwable) {
    if (!done) {
      done = true;
      body.completeExceptionally(throwable);
    }
  }

  @Override
  public synchronized void onComplete() {
    if (!done) {
      done = true;
      body.complete(new Result(out.toByteArray(), false));
    }
  }
}
