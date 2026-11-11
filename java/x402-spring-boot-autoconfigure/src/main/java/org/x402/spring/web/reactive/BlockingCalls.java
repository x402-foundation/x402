package org.x402.spring.web.reactive;

import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/** Runs the SDK's blocking calls (verify, settle, cancel) from reactive code. */
public final class BlockingCalls {

  private BlockingCalls() {}

  /**
   * Runs a blocking call on {@code boundedElastic}. Once started it is not interrupted by a
   * cancelled subscription (a client that went away): a settle or cancel always completes, and
   * its hooks run.
   *
   * @param <T> the result type
   * @param call the blocking call
   * @return the result, emitted when the call completes
   */
  public static <T> Mono<T> offload(Callable<T> call) {
    return Mono.fromFuture(() -> CompletableFuture.supplyAsync(() -> {
      try {
        return call.call();
      } catch (RuntimeException e) {
        throw e;
      } catch (Exception e) {
        throw new IllegalStateException(e);
      }
    }, task -> Schedulers.boundedElastic().schedule(task)), true);
  }
}
