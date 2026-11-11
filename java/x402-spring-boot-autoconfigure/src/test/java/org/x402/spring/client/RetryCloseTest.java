package org.x402.spring.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.mock.http.client.MockClientHttpRequest;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.http.HeaderCodec;
import org.x402.http.HostPolicy;
import org.x402.http.X402Headers;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestClientScheme;
import org.x402.spring.client.servlet.X402ClientHttpRequestFactory;

/** The recovered retry's response is closed if the hook throws. */
class RetryCloseTest {

  @Test
  void theRetryResponseIsClosedWhenTheSecondHookCallThrows() {
    X402Client client = new X402Client().register(HookRecorder.NET, new TestClientScheme());
    AtomicInteger calls = new AtomicInteger();
    client.onPaymentResponse(ctx -> {
      if (calls.incrementAndGet() == 1) {
        return true;
      }
      throw new IllegalStateException("second hook failed");
    });
    String required = HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "x",
        ResourceInfo.of("https://api.example.com/x"), List.of(new PaymentRequirements("exact",
            HookRecorder.NET, "USDM", "10000", "addr", 300, Map.of())), null));
    List<String> closed = new ArrayList<>();
    AtomicInteger sent = new AtomicInteger();
    ClientHttpRequestFactory fake = (uri, method) -> new MockClientHttpRequest(method, uri) {
      @Override
      protected ClientHttpResponse executeInternal() {
        int n = sent.incrementAndGet();
        return new X402ClientStarterTest.RecordingResponse(n == 1
            ? HttpStatus.PAYMENT_REQUIRED : HttpStatus.OK,
            n == 1 ? Map.of(X402Headers.PAYMENT_REQUIRED, required) : Map.of(),
            () -> closed.add("response-" + n));
      }
    };
    ClientHttpRequestFactory factory = X402ClientHttpRequestFactory.wrap(fake, client,
        HostPolicy.of(List.of("api.example.com")));

    assertThatThrownBy(() -> factory.createRequest(URI.create("https://api.example.com/x"),
        HttpMethod.GET).execute()).hasMessageContaining("second hook failed");
    assertThat(closed).containsExactly("response-1", "response-2", "response-3");
  }
}
