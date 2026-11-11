package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.core.Fixtures.PREPROD;

import java.net.URI;
import java.net.http.HttpClient.Redirect;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.x402.core.FakeClientScheme;
import org.x402.core.Fixtures;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.ResourceInfo;
import org.x402.http.ScriptedTransport.Reply;

/**
 * The payment-response hooks run on the thread that called {@code send}, as before the body
 * gating: a hook may block, call the same client, or rely on the caller's thread-local context.
 */
class X402HttpClientHookThreadTest {

  private static final String URL = "http://localhost/paid";
  private static final ExecutorService WORKER = Executors.newCachedThreadPool(r -> {
    Thread t = new Thread(r, "transport-worker");
    t.setDaemon(true);
    return t;
  });

  private static String required() {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(URL), List.of(Fixtures.requirements()), null));
  }

  private static boolean paid(HttpRequest r) {
    return r.headers().firstValue("PAYMENT-SIGNATURE").isPresent();
  }

  @Test
  void everyHookRunsOnTheCallingThread() throws Exception {
    AtomicInteger paidCalls = new AtomicInteger();
    List<Thread> transportThreads = new CopyOnWriteArrayList<>();
    // Like the JDK client, the transport answers on its own worker thread.
    ScriptedTransport transport = new ScriptedTransport(r -> {
      transportThreads.add(Thread.currentThread());
      if (!paid(r)) {
        return new Reply(402, Map.of("PAYMENT-REQUIRED", required()), 10);
      }
      return paidCalls.incrementAndGet() == 1 ? new Reply(402, Map.of(), 1000)
          : new Reply(200, Map.of(), 7);
    }, Redirect.NEVER) {
      @Override
      public <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> handler) {
        return CompletableFuture.supplyAsync(() -> {
          try {
            return super.send(request, handler);
          } catch (Exception e) {
            throw new CompletionException(e);
          }
        }, WORKER).join();
      }
    };
    List<Thread> hookThreads = new CopyOnWriteArrayList<>();
    AtomicInteger hookCalls = new AtomicInteger();
    X402Client recovering = new X402Client().register(PREPROD, new FakeClientScheme())
        .onPaymentResponse(c -> {
          hookThreads.add(Thread.currentThread());
          return hookCalls.incrementAndGet() == 1;
        });
    java.net.http.HttpClient client = X402HttpClient.wrap(transport, recovering,
        HostPolicy.of(List.of("localhost")));

    HttpResponse<String> response = client.send(HttpRequest.newBuilder(URI.create(URL)).build(),
        HttpResponse.BodyHandlers.ofString());

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(hookThreads).hasSize(2).containsOnly(Thread.currentThread());
  }
}
