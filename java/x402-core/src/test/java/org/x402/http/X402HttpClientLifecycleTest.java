package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.lang.reflect.Method;
import java.net.http.HttpClient;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.x402.core.client.X402Client;

/**
 * The wrapper delegates the JDK 21+ {@code HttpClient} lifecycle ({@code close}, {@code shutdown},
 * {@code shutdownNow}, {@code awaitTermination}, {@code isTerminated}) even though the module is
 * compiled for Java 17.
 */
class X402HttpClientLifecycleTest {

  private static boolean isTerminated(HttpClient client) throws Exception {
    Method m = HttpClient.class.getMethod("isTerminated");
    return (boolean) m.invoke(client);
  }

  @Test
  void closingTheWrapperClosesTheDelegate() throws Exception {
    assumeTrue(Runtime.version().feature() >= 21, "HttpClient lifecycle needs JDK 21");
    HttpClient delegate = HttpClient.newHttpClient();
    X402HttpClient wrapper = X402HttpClient.wrap(delegate, new X402Client());
    assertThat(wrapper.isTerminated()).isFalse();
    ((AutoCloseable) wrapper).close();
    assertThat(isTerminated(delegate)).isTrue();
    assertThat(wrapper.isTerminated()).isTrue();
    assertThat(wrapper.awaitTermination(Duration.ofSeconds(1))).isTrue();

    HttpClient other = HttpClient.newHttpClient();
    X402HttpClient second = X402HttpClient.wrap(other, new X402Client());
    second.shutdown();
    second.shutdownNow();
    assertThat(second.awaitTermination(Duration.ofSeconds(5))).isTrue();
    assertThat(isTerminated(other)).isTrue();
  }
}
