package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.x402.core.client.X402Client;

/**
 * {@code sendAsync} runs the blocking paying flow on the wrapper's own threads: on the delegate's
 * executor it would occupy a thread the delegate itself needs to finish the exchange.
 */
class X402HttpClientAsyncTest {

  @Test
  void sendAsyncCompletesOverASingleThreadDelegateExecutor() throws Exception {
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/ok", exchange -> {
      byte[] body = "ok".getBytes(StandardCharsets.UTF_8);
      exchange.sendResponseHeaders(200, body.length);
      exchange.getResponseBody().write(body);
      exchange.close();
    });
    server.start();
    ExecutorService single = Executors.newFixedThreadPool(1);
    try {
      HttpClient delegate = HttpClient.newBuilder().executor(single).build();
      X402HttpClient client = X402HttpClient.wrap(delegate, new X402Client());
      URI uri = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/ok");

      HttpResponse<String> response = client
          .sendAsync(HttpRequest.newBuilder(uri).GET().build(), HttpResponse.BodyHandlers.ofString())
          .get(10, TimeUnit.SECONDS);

      assertThat(response.statusCode()).isEqualTo(200);
      assertThat(response.body()).isEqualTo("ok");
    } finally {
      single.shutdownNow();
      server.stop(0);
    }
  }
}
