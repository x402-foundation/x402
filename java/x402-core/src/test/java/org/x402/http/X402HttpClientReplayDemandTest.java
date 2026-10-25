package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.core.Fixtures.PREPROD;

import java.net.URI;
import java.net.http.HttpClient.Redirect;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandler;
import java.net.http.HttpResponse.BodySubscriber;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.x402.core.FakeClientScheme;
import org.x402.core.Fixtures;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.ResourceInfo;
import org.x402.http.ScriptedTransport.Reply;

/** A held 402 body is handed to the caller's subscriber only as its demand allows. */
class X402HttpClientReplayDemandTest {

  @Test
  void aDeclined402ReachesALazySubscriberOnlyAfterItRequests() throws Exception {
    String required = HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of("http://other.example/x"), List.of(Fixtures.requirements()), null));
    ScriptedTransport transport = new ScriptedTransport(
        r -> new Reply(402, Map.of("PAYMENT-REQUIRED", required), 100), Redirect.NEVER);
    java.net.http.HttpClient client = X402HttpClient.wrap(transport,
        new X402Client().register(PREPROD, new FakeClientScheme()),
        HostPolicy.of(List.of("localhost")));
    AtomicBoolean requested = new AtomicBoolean();
    AtomicBoolean early = new AtomicBoolean();
    AtomicInteger received = new AtomicInteger();
    BodyHandler<Integer> lazy = info -> new BodySubscriber<Integer>() {
      private final CompletableFuture<Integer> done = new CompletableFuture<>();

      @Override
      public CompletionStage<Integer> getBody() {
        return done;
      }

      @Override
      public void onSubscribe(Flow.Subscription s) {
        // Asks for data later, from another thread, as a reactive bridge does.
        CompletableFuture.runAsync(() -> {
          requested.set(true);
          s.request(1);
        });
      }

      @Override
      public void onNext(List<ByteBuffer> items) {
        early.compareAndSet(false, !requested.get());
        items.forEach(b -> received.addAndGet(b.remaining()));
      }

      @Override
      public void onError(Throwable t) {
        done.completeExceptionally(t);
      }

      @Override
      public void onComplete() {
        done.complete(received.get());
      }
    };

    HttpResponse<Integer> response = client.send(
        HttpRequest.newBuilder(URI.create("http://localhost/x")).build(), lazy);

    assertThat(response.statusCode()).isEqualTo(402);
    assertThat(response.body()).isEqualTo(100);
    assertThat(early.get()).isFalse();
  }
}
