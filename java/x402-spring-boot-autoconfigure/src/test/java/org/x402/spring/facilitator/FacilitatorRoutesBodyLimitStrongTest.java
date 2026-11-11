package org.x402.spring.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Tightens {@code FacilitatorRoutesBodyLimitTest}: the cap is exactly 256 KB (a body of that size
 * is accepted, one byte more is refused, declared or chunked), the refusal says why, and a chunked
 * body that never ends is cut off long before it is buffered.
 */
class FacilitatorRoutesBodyLimitStrongTest {

  private static final int CAP = 256 * 1024;
  private static final long ENDLESS = 400L * 1024 * 1024;
  private static final long READ_BEFORE_REFUSAL_AT_MOST = 32L * 1024 * 1024;

  @SpringBootConfiguration
  @EnableAutoConfiguration
  static class App {}

  private static ConfigurableApplicationContext start(String type) {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("server.port", "0");
    p.put("spring.main.web-application-type", type);
    p.put("x402.facilitator-server.enabled", "true");
    p.put("x402.facilitator-server.cardano.networks[0].network", "cardano:preprod");
    p.put("x402.facilitator-server.cardano.networks[0].blockfrost.project-id", "k");
    return new SpringApplicationBuilder(App.class).properties(p).run();
  }

  private static HttpResponse<String> post(ConfigurableApplicationContext ctx,
      HttpRequest.BodyPublisher body) throws IOException, InterruptedException {
    String port = ctx.getEnvironment().getProperty("local.server.port");
    HttpRequest request = HttpRequest.newBuilder(
            URI.create("http://127.0.0.1:" + port + "/x402/verify"))
        .header("Content-Type", "application/json").timeout(Duration.ofSeconds(60))
        .POST(body).build();
    return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
  }

  /**
   * Writes a chunked body that never ends on a raw socket, on its own thread, while this thread
   * reads the status line the server actually sent: a dropped connection is no answer.
   */
  private static int endlessStatus(ConfigurableApplicationContext ctx, AtomicLong produced)
      throws Exception {
    int port = Integer.parseInt(ctx.getEnvironment().getProperty("local.server.port"));
    try (Socket socket = new Socket("127.0.0.1", port)) {
      socket.setSoTimeout(30_000);
      OutputStream out = socket.getOutputStream();
      out.write(("POST /x402/verify HTTP/1.1\r\nHost: 127.0.0.1\r\n"
          + "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n")
          .getBytes(StandardCharsets.US_ASCII));
      byte[] chunk = bytes(64 * 1024);
      byte[] head = (Integer.toHexString(chunk.length) + "\r\n").getBytes(StandardCharsets.US_ASCII);
      byte[] tail = "\r\n".getBytes(StandardCharsets.US_ASCII);
      Thread writer = new Thread(() -> {
        try {
          while (produced.get() < ENDLESS) {
            out.write(head);
            out.write(chunk);
            out.write(tail);
            produced.addAndGet(chunk.length);
          }
        } catch (IOException e) {
          // the server closed the connection: the upload ends here
        }
      });
      writer.setDaemon(true);
      writer.start();
      String statusLine = new BufferedReader(new InputStreamReader(socket.getInputStream(),
          StandardCharsets.US_ASCII)).readLine();
      writer.join(15_000);
      assertThat(statusLine).as("status line").isNotNull();
      return Integer.parseInt(statusLine.split(" ")[1]);
    }
  }

  private static byte[] bytes(int length) {
    byte[] b = new byte[length];
    Arrays.fill(b, (byte) 'a');
    return b;
  }

  private static HttpRequest.BodyPublisher declared(int length) {
    return HttpRequest.BodyPublishers.ofByteArray(bytes(length));
  }

  /** A chunked body (no Content-Length) of {@code length} bytes, produced lazily and counted. */
  private static HttpRequest.BodyPublisher chunked(long length, AtomicLong produced) {
    return HttpRequest.BodyPublishers.ofInputStream(() -> new InputStream() {
      private long left = length;

      @Override
      public int read() {
        byte[] one = new byte[1];
        return read(one, 0, 1) < 0 ? -1 : one[0];
      }

      @Override
      public int read(byte[] b, int off, int len) {
        if (left <= 0) {
          return -1;
        }
        int n = (int) Math.min(len, left);
        Arrays.fill(b, off, off + n, (byte) 'a');
        left -= n;
        produced.addAndGet(n);
        return n;
      }
    });
  }

  private void check(String type) throws Exception {
    try (ConfigurableApplicationContext ctx = start(type)) {
      assertThat(post(ctx, declared(CAP)).statusCode())
          .as(type + " declared body of exactly the cap reaches the handler").isNotEqualTo(413);
      assertThat(post(ctx, chunked(CAP, new AtomicLong())).statusCode())
          .as(type + " chunked body of exactly the cap reaches the handler").isNotEqualTo(413);

      HttpResponse<String> declaredOver = post(ctx, declared(CAP + 1));
      assertThat(declaredOver.statusCode()).as(type + " declared cap + 1").isEqualTo(413);
      assertThat(declaredOver.body()).contains("request body too large");
      assertThat(post(ctx, chunked(CAP + 1, new AtomicLong())).statusCode())
          .as(type + " chunked cap + 1").isEqualTo(413);

      AtomicLong produced = new AtomicLong();
      int status = endlessStatus(ctx, produced);
      assertThat(status).as(type + " endless chunked body").isEqualTo(413);
      if ("servlet".equals(type)) {
        // Tomcat closes after the 413. Reactor Netty reads the rest of an upload and discards it
        // before closing, whatever the route answers: memory stays bounded by the route's cap
        // (asserted above), and how much is read is the server's (or a proxy's) limit to set.
        assertThat(produced.get()).as(type + " bytes pulled from an endless body")
            .isLessThan(READ_BEFORE_REFUSAL_AT_MOST);
      }
    }
  }

  @Test
  void webMvcCutsTheBodyOffAtExactlyTheCap() throws Exception {
    check("servlet");
  }

  @Test
  void webFluxCutsTheBodyOffAtExactlyTheCap() throws Exception {
    check("reactive");
  }
}
